import type { Logger } from "pino";
import * as Y from "yjs";
import type { BoardRepository, StoredUpdate } from "../persistence/repository";
import type { SyncMetrics } from "./metrics";

export interface Attribution {
  clientId: number | null;
  userId: string | null;
}

export interface RoomPersistenceOptions {
  boardId: string;
  doc: Y.Doc;
  repository: BoardRepository;
  logger: Logger;
  metrics: SyncMetrics;
  /** Highest seq already stored for this board. */
  maxSeq: number;
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
 */
export class RoomPersistence {
  private pending: StoredUpdate[] = [];
  private nextSeq: number;
  private updatesSinceSnapshot: number;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private retryDelay = RETRY_MIN_MS;
  private closed = false;

  constructor(private readonly options: RoomPersistenceOptions) {
    this.nextSeq = options.maxSeq + 1;
    this.updatesSinceSnapshot = options.updatesSinceSnapshot;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  enqueue(update: Uint8Array, attribution: Attribution): void {
    this.pending.push({
      seq: 0,
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
   */
  async close(deadline: number): Promise<void> {
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
    if (this.pending.length === 0) return;
    const batch = this.pending.splice(0, MAX_BATCH).map((u) => ({ ...u, seq: this.nextSeq++ }));
    // Cut point: if the whole queue fits in this batch, the current state vector is exactly
    // what becomes durable when it commits.
    const durableVector = this.pending.length === 0 ? Y.encodeStateVector(this.options.doc) : null;
    const started = performance.now();
    try {
      await this.options.repository.append(this.options.boardId, batch);
    } catch (error) {
      // Put the batch back (in order) and retry later. Seqs are reassigned on retry.
      this.nextSeq -= batch.length;
      this.pending.unshift(...batch.map((u) => ({ ...u, seq: 0 })));
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
    this.options.metrics.flushSeconds.observe((performance.now() - started) / 1000);
    this.options.metrics.pendingUpdates.dec(batch.length);
    this.updatesSinceSnapshot += batch.length;

    if (durableVector) this.options.onPersisted(durableVector);
    if (this.pending.length > 0) this.scheduleFlush(0);
    if (this.updatesSinceSnapshot >= this.options.snapshotEvery) await this.compactNow();
  }

  private async compactNow(): Promise<void> {
    try {
      const result = await this.options.repository.compact(this.options.boardId, buildSnapshot);
      if (result) {
        this.updatesSinceSnapshot = 0;
        this.options.metrics.compactions.inc();
        this.options.logger.debug({ boardId: this.options.boardId, ...result }, "compacted board");
      }
    } catch (error) {
      // Compaction is an optimisation; updates remain safely in board_updates.
      this.options.logger.error({ err: error, boardId: this.options.boardId }, "compaction failed");
    }
  }
}
