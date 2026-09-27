import type { Logger } from "pino";
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import {
  encodeAwarenessMessage,
  encodeMessage,
  MESSAGE_PERSISTED,
  MESSAGE_SYNC,
  readAwarenessEntries,
} from "@whiteboard/shared/sync";
import { CLUSTER_KINDS, clusterKindName, type ClusterMessage } from "../cluster/envelope";
import type { PersistenceLease } from "../cluster/lease";
import type { RoomBus } from "../cluster/roomBus";
import type { BoardRepository, LoadedBoard } from "../persistence/repository";
import { EncryptedRoom } from "./encryptedRoom";
import type { SyncMetrics } from "./metrics";
import { RoomPersistence, YjsContent } from "./roomPersistence";
import { mergeStateVectors, type ManagedRoom, type RoomLoad, type RoomMember } from "./roomTypes";

export { mergeStateVectors, type RoomLoad, type RoomMember };

/** Transaction origin for documents loaded from the database: not re-persisted, not broadcast. */
export const LOAD_ORIGIN = Symbol("load");
/**
 * Transaction origin for changes received from another instance: sent to our clients and
 * persisted if we are the writer, but never published again (no echo loops).
 */
export const REMOTE_ORIGIN = Symbol("remote");

/**
 * One board's live state on this instance: its Y.Doc, the awareness (presence) of everyone
 * connected (here or on other instances), and this instance's connections. Changes are
 * broadcast to every other local member and published to the other instances; document
 * changes are also queued for durable storage when this instance is the room's writer.
 */
export class Room implements ManagedRoom {
  readonly doc = new Y.Doc();
  readonly awareness: Awareness;
  readonly members = new Set<RoomMember>();
  /** Which local member owns each awareness client id, so nobody can spoof another user. */
  readonly awarenessOwners = new Map<number, RoomMember>();
  /** Awareness client ids held by clients of other instances (id → instance). */
  readonly remoteAwareness = new Map<number, string>();
  evictTimer: NodeJS.Timeout | null = null;
  persistence: RoomPersistence | null = null;
  /** Being saved for eviction or shutdown: lease changes are paused. */
  closing = false;
  /** Whether this instance holds the room's persistence lease. */
  holdsLease = false;
  /** A lease acquire/renew for this room is in flight. */
  leaseBusy = false;
  /** The state vector known to be committed to Postgres (sent to clients as "persisted"). */
  persistedVector: Uint8Array = Y.encodeStateVector(new Y.Doc());
  /** Resolves when the document has been loaded from the database. */
  ready: Promise<RoomLoad> = Promise.resolve({ ok: true });
  /** Cluster messages that arrived while loading; applied once the document is loaded. */
  private queuedCluster: ClusterMessage[] | null = [];

  constructor(
    readonly boardId: string,
    private readonly bus: RoomBus,
    private readonly metrics: SyncMetrics,
  ) {
    this.awareness = new Awareness(this.doc);
    // The server itself has no presence.
    this.awareness.setLocalState(null);

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === LOAD_ORIGIN) return;
      const message = encodeMessage(MESSAGE_SYNC, (encoder) => {
        syncProtocol.writeUpdate(encoder, update);
      });
      this.broadcast(message, origin);
      const author = this.isMember(origin)
        ? origin.attribution()
        : { clientId: null, userId: null };
      this.persistence?.enqueue(update, author);
      if (origin !== REMOTE_ORIGIN) this.publish(CLUSTER_KINDS.update, update);
    });

    this.awareness.on(
      "update",
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        const changed = [...added, ...updated, ...removed];
        if (changed.length === 0) return;
        for (const id of removed) this.remoteAwareness.delete(id);
        const update = encodeAwarenessUpdate(this.awareness, changed);
        this.broadcast(encodeAwarenessMessage(update), origin);
        // Only our own clients' presence is published; each instance times out stale
        // states on its own ("timeout" origin), so those removals aren't sent either.
        if (this.isMember(origin)) this.publish(CLUSTER_KINDS.awareness, update);
      },
    );
  }

  /** A method, not a field read, so checks after an `await` aren't narrowed away. */
  isClosing(): boolean {
    return this.closing;
  }

  get loaded(): boolean {
    return this.queuedCluster === null;
  }

  persistedMessage(): Uint8Array {
    return encodeMessage(MESSAGE_PERSISTED, (encoder) => {
      encoding.writeVarUint8Array(encoder, this.persistedVector);
    });
  }

  /**
   * Records what is durable and tells local clients. Vectors from different writers (only
   * during a handover or split brain) each describe committed data, so we keep their union.
   */
  markPersisted(stateVector: Uint8Array, announce: boolean): void {
    this.persistedVector = mergeStateVectors(this.persistedVector, stateVector);
    this.broadcast(this.persistedMessage(), null);
    if (announce) this.publish(CLUSTER_KINDS.persisted, stateVector);
  }

  /** The document is loaded: apply what other instances sent meanwhile, then catch up. */
  finishLoading(): void {
    const queued = this.queuedCluster ?? [];
    this.queuedCluster = null;
    for (const message of queued) this.handleCluster(message);
    this.requestSync();
    this.publish(CLUSTER_KINDS.awarenessRequest, new Uint8Array());
  }

  /** Ask the other instances for anything we're missing (they reply with a diff). */
  requestSync(): void {
    this.publish(CLUSTER_KINDS.syncRequest, Y.encodeStateVector(this.doc));
  }

  handleCluster(message: ClusterMessage): void {
    if (this.queuedCluster) {
      this.queuedCluster.push(message);
      return;
    }
    switch (message.kind) {
      case CLUSTER_KINDS.update:
      case CLUSTER_KINDS.syncReply:
        Y.applyUpdate(this.doc, message.payload, REMOTE_ORIGIN);
        return;
      case CLUSTER_KINDS.syncRequest:
        this.answerSyncRequest(message.from, message.payload);
        return;
      case CLUSTER_KINDS.awareness:
        this.applyRemoteAwareness(message.from, message.payload);
        return;
      case CLUSTER_KINDS.awarenessRequest: {
        const ours = [...this.awarenessOwners.keys()];
        if (ours.length > 0)
          this.publish(CLUSTER_KINDS.awareness, encodeAwarenessUpdate(this.awareness, ours));
        return;
      }
      case CLUSTER_KINDS.persisted:
        // While we write ourselves, only our own commits count.
        if (!this.persistence?.isActive) this.markPersisted(message.payload, false);
        return;
      case CLUSTER_KINDS.leaseReleased:
      case CLUSTER_KINDS.peerLeft:
        return; // Handled by the RoomManager / private rooms only.
    }
  }

  private answerSyncRequest(from: string, stateVector: Uint8Array): void {
    const theirs = Y.decodeStateVector(stateVector);
    // Everything they lack. Always sent (it also carries deletions, which don't show in a
    // state vector); cheap when they're up to date.
    this.bus.publish(this.boardId, {
      kind: CLUSTER_KINDS.syncReply,
      payload: Y.encodeStateAsUpdate(this.doc, stateVector),
      to: from,
    });
    this.metrics.clusterMessages.inc({ kind: "syncReply", direction: "out" });
    // If they have something we lack, ask for it too, so both sides converge in one round.
    for (const [client, clock] of theirs) {
      if (clock > Y.getState(this.doc.store, client)) {
        this.requestSync();
        return;
      }
    }
  }

  private applyRemoteAwareness(from: string, update: Uint8Array): void {
    const entries = readAwarenessEntries(update);
    if (!entries) {
      this.metrics.clusterDropped.inc({ reason: "awareness_invalid" });
      return;
    }
    // A client id held by one of our own connections wins: the client moved here (e.g. its
    // old instance is shutting down and announces it left). Never let another instance
    // overwrite or remove a local client's presence.
    if (entries.some(({ clientId }) => this.awarenessOwners.has(clientId))) {
      this.metrics.clusterDropped.inc({ reason: "awareness_conflict" });
      return;
    }
    for (const { clientId, state } of entries) {
      if (state === null) this.remoteAwareness.delete(clientId);
      else this.remoteAwareness.set(clientId, from);
    }
    applyAwarenessUpdate(this.awareness, update, REMOTE_ORIGIN);
  }

  private publish(kind: (typeof CLUSTER_KINDS)[keyof typeof CLUSTER_KINDS], payload: Uint8Array) {
    this.bus.publish(this.boardId, { kind, payload });
    this.metrics.clusterMessages.inc({ kind: clusterKindName(kind), direction: "out" });
  }

  private isMember(origin: unknown): origin is RoomMember {
    return typeof origin === "object" && origin !== null && this.members.has(origin as RoomMember);
  }

  private broadcast(message: Uint8Array, except: unknown): void {
    for (const member of this.members) {
      if (member !== except) member.send(message);
    }
  }

  applyLoaded(loaded: LoadedBoard): void {
    Y.transact(
      this.doc,
      () => {
        if (loaded.snapshot) Y.applyUpdate(this.doc, loaded.snapshot.state, LOAD_ORIGIN);
        for (const u of loaded.updates) Y.applyUpdate(this.doc, u.update, LOAD_ORIGIN);
      },
      LOAD_ORIGIN,
    );
    this.persistedVector = Y.encodeStateVector(this.doc);
  }

  createContent(repository: BoardRepository): YjsContent {
    return new YjsContent(this.doc, repository, this.boardId);
  }

  addMember(member: RoomMember): void {
    this.members.add(member);
  }

  removeMember(member: RoomMember): void {
    const owned = [...this.awarenessOwners]
      .filter(([, owner]) => owner === member)
      .map(([id]) => id);
    for (const id of owned) this.awarenessOwners.delete(id);
    // Tell everyone else (here and on other instances) this member's cursors are gone. The
    // member is still in the room here, so the removal counts as its own and is published.
    if (owned.length > 0) removeAwarenessStates(this.awareness, owned, member);
    this.members.delete(member);
  }

  destroy(): void {
    if (this.evictTimer) clearTimeout(this.evictTimer);
    this.persistence?.dispose();
    this.awareness.destroy();
    this.doc.destroy();
  }
}

export interface RoomManagerOptions {
  /** How long an empty room stays in memory, so quick reconnects don't reload it. */
  graceMs: number;
  metrics: SyncMetrics;
  logger: Logger;
  repository: BoardRepository;
  flushMs: number;
  snapshotEvery: number;
  /** Room traffic between instances (LocalRoomBus when running alone). */
  bus: RoomBus;
  /** Who persists each room (LocalLease when running alone: always us). */
  lease: PersistenceLease;
  /** How often held leases are renewed and free ones claimed (a third of the lease TTL). */
  leaseRenewMs: number;
  /** How often each room asks the other instances for anything it missed. */
  resyncMs: number;
  /** Longest a room waits for its Redis subscription before loading anyway. */
  subscribeTimeoutMs?: number;
}

/**
 * The rooms this instance holds in memory. Each is backed by durable storage and, with
 * several instances, kept in sync with the same room on the others through the RoomBus.
 */
export class RoomManager {
  private readonly rooms = new Map<string, ManagedRoom>();
  private readonly leaseTimer: NodeJS.Timeout;
  private readonly resyncTimer: NodeJS.Timeout;
  private readonly stopReconnect: () => void;

  constructor(private readonly options: RoomManagerOptions) {
    this.leaseTimer = setInterval(() => {
      for (const room of this.rooms.values()) void this.maintainLease(room);
    }, options.leaseRenewMs);
    this.leaseTimer.unref();
    // Redis pub/sub may drop messages (e.g. during a reconnect); this repairs any gap.
    this.resyncTimer = setInterval(() => {
      this.resyncAll("periodic");
    }, options.resyncMs);
    this.resyncTimer.unref();
    this.stopReconnect = options.bus.onReconnect(() => {
      this.resyncAll("reconnect");
    });
  }

  get size(): number {
    return this.rooms.size;
  }

  /** A normal board's room, if this instance holds it. */
  get(boardId: string): Room | undefined {
    const room = this.rooms.get(boardId);
    return room instanceof Room ? room : undefined;
  }

  /** A private board's room, if this instance holds it. */
  getEncrypted(boardId: string): EncryptedRoom | undefined {
    const room = this.rooms.get(boardId);
    return room instanceof EncryptedRoom ? room : undefined;
  }

  /**
   * Gets or creates (and starts loading) the room, and cancels any pending eviction. Whether
   * a board is private comes from the database at connection time and never changes, so
   * both kinds never exist for one board.
   */
  acquire(boardId: string, encrypted: boolean): ManagedRoom {
    let room = this.rooms.get(boardId);
    if (!room) {
      const created: ManagedRoom = encrypted
        ? new EncryptedRoom(boardId, {
            bus: this.options.bus,
            metrics: this.options.metrics,
            logger: this.options.logger,
            repository: this.options.repository,
          })
        : new Room(boardId, this.options.bus, this.options.metrics);
      // Register before loading: a load that fails must be able to remove the room again.
      this.rooms.set(boardId, created);
      created.ready = this.load(created);
      room = created;
      this.options.metrics.roomsActive.set(this.rooms.size);
    }
    if (room.evictTimer) {
      clearTimeout(room.evictTimer);
      room.evictTimer = null;
    }
    return room;
  }

  join(room: ManagedRoom, member: RoomMember): void {
    room.addMember(member);
  }

  leave(room: ManagedRoom, member: RoomMember): void {
    room.removeMember(member);
    if (room.members.size === 0) this.scheduleEviction(room);
  }

  /**
   * Saves every room (graceful shutdown): writers flush and snapshot, non-writers catch the
   * database up with anything the writer may lack; then leases are handed over. Rooms keep
   * their members; the caller closes connections afterwards so the final "persisted"
   * acknowledgements are delivered.
   */
  async flushAll(deadline: number): Promise<void> {
    await Promise.all(
      [...this.rooms.values()].map(async (room) => {
        // Rooms still loading may hold edits received before shutdown; let them apply first.
        await room.ready;
        room.closing = true;
        await room.persistence?.close(deadline);
        await this.releaseLease(room);
      }),
    );
  }

  destroy(): void {
    clearInterval(this.leaseTimer);
    clearInterval(this.resyncTimer);
    this.stopReconnect();
    for (const room of this.rooms.values()) {
      this.options.bus.leave(room.boardId);
      room.destroy();
    }
    this.rooms.clear();
    this.options.metrics.roomsActive.set(0);
    this.options.metrics.roomsWriter.set(0);
  }

  private async load(room: ManagedRoom): Promise<RoomLoad> {
    const started = performance.now();
    // Subscribe BEFORE reading the database, so no update published after the read can be
    // missed (earlier ones are in the database or arrive via the sync request below).
    await this.subscribe(room);
    try {
      const loaded = await this.options.repository.load(room.boardId);
      if (loaded.deleted) {
        this.drop(room);
        return { ok: false, reason: "deleted" };
      }
      room.applyLoaded(loaded);
      const writer = await this.tryAcquireLease(room);
      room.persistence = new RoomPersistence({
        boardId: room.boardId,
        content: room.createContent(this.options.repository),
        repository: this.options.repository,
        logger: this.options.logger,
        metrics: this.options.metrics,
        active: writer,
        updatesSinceSnapshot: loaded.updates.length,
        flushMs: this.options.flushMs,
        snapshotEvery: this.options.snapshotEvery,
        onPersisted: (vector) => {
          room.markPersisted(vector, true);
        },
      });
      this.updateWriterGauge();
      room.finishLoading();
      this.options.metrics.loadSeconds.observe((performance.now() - started) / 1000);
      return { ok: true };
    } catch (error) {
      this.options.logger.error({ err: error, boardId: room.boardId }, "failed to load board");
      this.drop(room);
      return { ok: false, reason: "error" };
    }
  }

  private async subscribe(room: ManagedRoom): Promise<void> {
    const { bus, logger, subscribeTimeoutMs = 2_000 } = this.options;
    let timer: NodeJS.Timeout | undefined;
    const joined = bus.join(room.boardId, (message) => {
      this.options.metrics.clusterMessages.inc({
        kind: clusterKindName(message.kind),
        direction: "in",
      });
      if (message.kind === CLUSTER_KINDS.leaseReleased) void this.maintainLease(room);
      else room.handleCluster(message);
    });
    try {
      // With Redis down the subscription waits for the reconnect; don't block the board on
      // it. The reconnect handler resyncs every room once the bus is back.
      await Promise.race([
        joined,
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error("subscribe timed out"));
          }, subscribeTimeoutMs);
        }),
      ]);
    } catch (error) {
      logger.warn(
        { err: error, boardId: room.boardId },
        "room bus unavailable; opening the room without it",
      );
      joined.catch(() => undefined);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Keeps lease ownership current: the writer renews (and stops writing if it lost the
   * lease), others claim a free lease (e.g. the writer died or left the room).
   */
  private async maintainLease(room: ManagedRoom): Promise<void> {
    const persistence = room.persistence;
    if (!persistence || room.closing || room.leaseBusy) return;
    room.leaseBusy = true;
    const wasWriting = persistence.isActive;
    try {
      if (persistence.isActive) {
        const held = await this.renewLease(room);
        if (!held && !room.isClosing()) {
          this.options.logger.warn({ boardId: room.boardId }, "persistence lease lost");
          this.options.metrics.leaseChanges.inc({ change: "lost" });
          await persistence.deactivate();
        }
      } else if (await this.tryAcquireLease(room)) {
        if (room.isClosing()) return;
        this.options.logger.info({ boardId: room.boardId }, "took over room persistence");
        await persistence.activate();
      }
    } finally {
      room.leaseBusy = false;
      if (persistence.isActive !== wasWriting) this.updateWriterGauge();
    }
  }

  /**
   * True when this instance should write the room. If Redis can't be reached we write
   * anyway (fail open): writes are idempotent, and otherwise nobody might persist.
   */
  private async tryAcquireLease(room: ManagedRoom): Promise<boolean> {
    try {
      const acquired = await this.options.lease.acquire(room.boardId);
      if (acquired && !room.holdsLease)
        this.options.metrics.leaseChanges.inc({ change: "acquired" });
      room.holdsLease = acquired;
      return acquired;
    } catch (error) {
      this.options.logger.warn(
        { err: error, boardId: room.boardId },
        "persistence lease unavailable; writing without it",
      );
      this.options.metrics.leaseChanges.inc({ change: "fail_open" });
      room.holdsLease = false;
      return true;
    }
  }

  private async renewLease(room: ManagedRoom): Promise<boolean> {
    try {
      // Written without the lease (Redis was down): take it properly now if it's free.
      const held = room.holdsLease
        ? await this.options.lease.renew(room.boardId)
        : await this.options.lease.acquire(room.boardId);
      room.holdsLease = held;
      return held;
    } catch {
      return true; // Redis unreachable: keep writing (see tryAcquireLease).
    }
  }

  private async releaseLease(room: ManagedRoom): Promise<void> {
    if (!room.holdsLease) return;
    room.holdsLease = false;
    try {
      await this.options.lease.release(room.boardId);
      this.options.metrics.leaseChanges.inc({ change: "released" });
      // Let another instance that still has the room take over now, not at its next tick.
      this.options.bus.publish(room.boardId, {
        kind: CLUSTER_KINDS.leaseReleased,
        payload: new Uint8Array(),
      });
    } catch (error) {
      // It expires on its own.
      this.options.logger.warn({ err: error, boardId: room.boardId }, "lease release failed");
    }
  }

  private resyncAll(reason: "periodic" | "reconnect"): void {
    for (const room of this.rooms.values()) {
      if (!room.loaded) continue;
      room.requestSync();
      if (reason === "reconnect") void this.maintainLease(room);
    }
    if (this.rooms.size > 0) this.options.metrics.resyncs.inc({ reason });
  }

  private scheduleEviction(room: ManagedRoom): void {
    if (room.evictTimer) return;
    room.evictTimer = setTimeout(() => {
      room.evictTimer = null;
      void this.evict(room);
    }, this.options.graceMs);
    room.evictTimer.unref();
  }

  private async evict(room: ManagedRoom): Promise<void> {
    if (room.members.size > 0 || this.rooms.get(room.boardId) !== room) return;
    // A room still loading may have edits waiting to be applied; let them land first.
    await room.ready;
    room.closing = true;
    const wasWriter = room.persistence?.isActive ?? false;
    await room.persistence?.close(Date.now() + 10_000);
    const unsaved = room.persistence?.pendingCount ?? 0;
    if (room.members.size > 0 || unsaved > 0) {
      // Someone rejoined while we were saving, or the save failed: keep the room. Unsaved
      // edits are never dropped; eviction is retried later.
      if (unsaved > 0)
        this.options.logger.warn(
          { boardId: room.boardId },
          "eviction postponed: updates not yet persisted",
        );
      room.closing = false;
      room.persistence?.reopen(wasWriter || unsaved > 0);
      if (room.members.size === 0) this.scheduleEviction(room);
      return;
    }
    this.drop(room);
    room.destroy();
    await this.releaseLease(room);
  }

  private drop(room: ManagedRoom): void {
    if (this.rooms.get(room.boardId) === room) {
      this.rooms.delete(room.boardId);
      this.options.bus.leave(room.boardId);
    }
    this.options.metrics.roomsActive.set(this.rooms.size);
    this.updateWriterGauge();
  }

  private updateWriterGauge(): void {
    let writing = 0;
    for (const room of this.rooms.values()) if (room.persistence?.isActive) writing += 1;
    this.options.metrics.roomsWriter.set(writing);
  }
}
