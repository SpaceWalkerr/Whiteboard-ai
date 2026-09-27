import type { Logger } from "pino";
import * as Y from "yjs";
import { missingFrom } from "@whiteboard/shared/sync";
import { BoardMissingError, type BoardRepository, type NewUpdate } from "../persistence/repository";
import type { SyncMetrics } from "./metrics";

export { missingFrom };

export interface Attribution {
  clientId: number | null;
  userId: string | null;
}

/**
 * What the write-ahead queue needs to know about a room's content. Normal boards are a
 * Y.Doc (YjsContent); private boards are a log of ciphertext the server can't read
 * (CipherLog in encryptedRoom.ts).
 */
export interface PersistedContent {
  /**
   * Describes everything the room holds right now. Sent to clients as "persisted" once it is
   * all committed: a Yjs state vector, or for private rooms each peer's highest counter.
   */
  durableMarker(): Uint8Array;
  /**
   * What the database lacks compared with this room (the writer changed, or a non-writer
   * leaves), plus how many stored updates follow the latest snapshot. Throws if the stored
   * board can't be read.
   */
  catchUp(): Promise<{ missing: NewUpdate[]; storedSinceSnapshot: number }>;
  /** Fallback when catchUp can't read the database: everything, as updates to write. */
  fullState(): NewUpdate[];
  /** A batch was committed; its updates got seqs firstSeq, firstSeq + 1, … in order. */
  committed(batch: readonly NewUpdate[], firstSeq: number): void;
  /**
   * Fold stored updates into a snapshot. Returns true when that happened now; a private
   * room asks a client instead and reports later through RoomPersistence.snapshotInstalled.
   */
  compact(): Promise<boolean>;
}

/** A normal board: the room's Y.Doc, compacted by merging on the server. */
export class YjsContent implements PersistedContent {
  constructor(
    private readonly doc: Y.Doc,
    private readonly repository: BoardRepository,
    private readonly boardId: string,
  ) {}

  durableMarker(): Uint8Array {
    return Y.encodeStateVector(this.doc);
  }

  /**
   * Exactly what the document has beyond the database: new content AND deletions (a deletion
   * doesn't show in a state vector, so comparing vectors isn't enough). The stored board is
   * rebuilt and our state applied to it; whatever that changes is missing.
   */
  async catchUp() {
    const stored = await this.repository.load(this.boardId);
    const missing = missingFrom(
      stored.snapshot?.state ?? null,
      stored.updates.map((u) => u.update),
      Y.encodeStateAsUpdate(this.doc),
    );
    return {
      missing:
        missing.length === 0
          ? []
          : [{ update: Y.mergeUpdates(missing), clientId: null, userId: null }],
      storedSinceSnapshot: stored.updates.length,
    };
  }

  fullState(): NewUpdate[] {
    return [{ update: Y.encodeStateAsUpdate(this.doc), clientId: null, userId: null }];
  }

  committed(): void {
    // Nothing to track: the state vector says it all.
  }

  async compact(): Promise<boolean> {
    return (await this.repository.compact(this.boardId, buildSnapshot)) !== null;
  }
}

export interface RoomPersistenceOptions {
  boardId: string;
  content: PersistedContent;
  repository: BoardRepository;
  logger: Logger;
  metrics: SyncMetrics;
  /**
   * Whether this instance starts as the room's writer (holds the persistence lease). A
   * non-writer ignores updates; the writer on another instance stores them.
   */
  active: boolean;
  /** Updates stored since the latest snapshot (triggers compaction). */
  updatesSinceSnapshot: number;
  flushMs: number;
  snapshotEvery: number;
  /** Called after each committed batch with the state vector that is now durable. */
  onPersisted: (stateVector: Uint8Array) => void;
}

const MAX_BATCH = 500;
const RETRY_MIN_MS = 100;
const RETRY_MAX_MS = 5_000;

/** Merge a snapshot and updates into one garbage-collected document state. */
export function buildSnapshot(
  snapshot: Uint8Array | null,
  updates: readonly Uint8Array[],
): Uint8Array {
  const doc = new Y.Doc();
  if (snapshot) Y.applyUpdate(doc, snapshot);
  for (const update of updates) Y.applyUpdate(doc, update);
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}

/**
 * Write-ahead persistence for one room.
 *
 * Every update applied to the room's document is queued here and written to board_updates in
 * batches (at most `flushMs` after it arrived, or sooner when the batch is full). Batches are
 * written one at a time, in order. Only after a batch commits do clients get a "persisted"
 * acknowledgement carrying the state vector captured when the batch was cut — at that moment
 * every update applied to the document was either in this batch or an earlier committed one,
 * so the vector exactly describes what is durable.
 *
 * On a database error the batch goes back to the front of the queue and is retried with
 * backoff; nothing is acknowledged until it commits.
 *
 * With several instances only the room's writer (lease holder) is `active`. An instance that
 * becomes the writer first writes a catch-up update: everything its document has that the
 * database lacks (edits the previous writer received but never committed, e.g. because it
 * died). Duplicate writes are harmless: seqs come from the database and Yjs updates are
 * idempotent.
 */
export class RoomPersistence {
  private pending: NewUpdate[] = [];
  private updatesSinceSnapshot: number;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private retryDelay = RETRY_MIN_MS;
  private closed = false;
  private disposed = false;
  private active: boolean;

  constructor(private readonly options: RoomPersistenceOptions) {
    this.updatesSinceSnapshot = options.updatesSinceSnapshot;
    this.active = options.active;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get isActive(): boolean {
    return this.active;
  }

  /**
   * Become the writer. Queues the catch-up write before anything else, so the first
   * acknowledgement covers everything in the document.
   */
  activate(): Promise<void> {
    if (this.active) return Promise.resolve();
    this.active = true;
    this.closed = false;
    const done = this.enqueueTask(() => this.catchUp());
    this.scheduleFlush(0);
    return done;
  }

  /** Stop writing (lease lost to another instance). What is already queued is still written. */
  async deactivate(): Promise<void> {
    if (!this.active) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.flush();
    this.active = false;
    this.options.metrics.pendingUpdates.dec(this.pending.length);
    this.pending = [];
  }

  enqueue(update: Uint8Array, attribution: Attribution): void {
    if (!this.active) return;
    this.pending.push({
      update,
      clientId: attribution.clientId,
      userId: attribution.userId,
    });
    this.options.metrics.pendingUpdates.inc();
    if (this.pending.length >= MAX_BATCH) this.scheduleFlush(0);
    else this.scheduleFlush(this.options.flushMs);
  }

  /** Writes everything queued so far; resolves once it is committed (or failed this attempt). */
  flush(): Promise<void> {
    return this.enqueueTask(() => this.flushNow());
  }

  /** Folds stored updates into a snapshot (and archives them). */
  compact(): Promise<void> {
    return this.enqueueTask(() => this.compactNow());
  }

  /**
   * Final flush + snapshot before the room is dropped or the server stops. Retries a failing
   * flush until `deadline` (epoch ms) so a brief database blip doesn't lose data on shutdown.
   *
   * A non-writer becomes a writer for this: it catches the database up with its document
   * first, so an instance never leaves a room holding edits that aren't stored (the writer
   * may have missed them, or be gone). Usually there is nothing to write.
   */
  async close(deadline: number): Promise<void> {
    if (!this.active) {
      this.active = true;
      void this.enqueueTask(() => this.catchUp());
    }
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.flush();
    while (this.pending.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(this.retryDelay, Math.max(0, deadline - Date.now()))),
      );
      await this.flush();
    }
    if (this.updatesSinceSnapshot > 0) await this.compact();
  }

  /** Stops all timers; nothing more is written (the room is gone). */
  dispose(): void {
    this.disposed = true;
    this.closed = true;
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Undo close(): someone rejoined the room while it was being saved for eviction. */
  reopen(active: boolean): void {
    this.closed = false;
    this.active = active;
    if (!active) {
      this.options.metrics.pendingUpdates.dec(this.pending.length);
      this.pending = [];
    } else if (this.pending.length > 0) this.scheduleFlush(0);
  }

  private scheduleFlush(delay: number): void {
    if (this.closed) return;
    if (this.timer && delay > 0) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
    this.timer.unref();
  }

  private enqueueTask(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async flushNow(): Promise<void> {
    if (this.disposed || this.pending.length === 0) return;
    const batch = this.pending.splice(0, MAX_BATCH);
    // Cut point: if the whole queue fits in this batch, the current state vector is exactly
    // what becomes durable when it commits.
    const durableVector = this.pending.length === 0 ? this.options.content.durableMarker() : null;
    const started = performance.now();
    let firstSeq: number;
    try {
      ({ firstSeq } = await this.options.repository.append(this.options.boardId, batch));
    } catch (error) {
      if (error instanceof BoardMissingError) {
        // The board was purged: nothing can ever be stored for it again.
        const dropped = batch.length + this.pending.length;
        this.options.logger.warn(
          { boardId: this.options.boardId, dropped },
          "board no longer exists; dropping updates",
        );
        this.options.metrics.pendingUpdates.dec(dropped);
        this.pending = [];
        return;
      }
      // Put the batch back (in order) and retry later.
      this.pending.unshift(...batch);
      this.options.metrics.persistFailures.inc();
      this.options.logger.error(
        { err: error, boardId: this.options.boardId, updates: batch.length },
        "failed to persist updates; will retry",
      );
      this.retryDelay = Math.min(RETRY_MAX_MS, this.retryDelay * 2);
      if (!this.closed) this.scheduleFlush(this.retryDelay);
      return;
    }
    this.retryDelay = RETRY_MIN_MS;
    this.options.content.committed(batch, firstSeq);
    this.options.metrics.flushSeconds.observe((performance.now() - started) / 1000);
    this.options.metrics.pendingUpdates.dec(batch.length);
    this.updatesSinceSnapshot += batch.length;

    if (durableVector) this.options.onPersisted(durableVector);
    if (this.pending.length > 0) this.scheduleFlush(0);
    if (this.updatesSinceSnapshot >= this.options.snapshotEvery) await this.compactNow();
  }

  /** Queue whatever the database lacks compared with this room (see PersistedContent). */
  private async catchUp(): Promise<void> {
    const { content, boardId } = this.options;
    let missing: NewUpdate[];
    try {
      const result = await content.catchUp();
      this.updatesSinceSnapshot = result.storedSinceSnapshot;
      missing = result.missing;
    } catch (error) {
      this.options.logger.warn(
        { err: error, boardId },
        "catch-up: could not read the stored board; writing the full document",
      );
      missing = content.fullState();
    }
    if (missing.length === 0) {
      // Everything we have is already stored (the previous writer committed it before it
      // went away). Say so, or our clients would wait for an acknowledgement forever.
      if (this.pending.length === 0) this.options.onPersisted(content.durableMarker());
      return;
    }
    this.pending.unshift(...missing);
    this.options.metrics.pendingUpdates.inc(missing.length);
    const bytes = missing.reduce((sum, u) => sum + u.update.byteLength, 0);
    this.options.logger.info({ boardId, bytes, updates: missing.length }, "catch-up write queued");
  }

  /**
   * A private room's client-made snapshot was stored (outside this queue, whenever the
   * client answered): `archived` stored updates no longer follow the latest snapshot.
   */
  snapshotInstalled(archived: number): void {
    this.updatesSinceSnapshot = Math.max(0, this.updatesSinceSnapshot - archived);
    this.options.metrics.compactions.inc();
  }

  private async compactNow(): Promise<void> {
    try {
      if (await this.options.content.compact()) {
        this.updatesSinceSnapshot = 0;
        this.options.metrics.compactions.inc();
        this.options.logger.debug({ boardId: this.options.boardId }, "compacted board");
      }
    } catch (error) {
      // Compaction is an optimisation; updates remain safely in board_updates.
      this.options.logger.error({ err: error, boardId: this.options.boardId }, "compaction failed");
    }
  }
}
