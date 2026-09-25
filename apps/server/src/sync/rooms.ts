import type { Logger } from "pino";
import { Awareness, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import {
  encodeAwarenessMessage,
  encodeMessage,
  MESSAGE_PERSISTED,
  MESSAGE_SYNC,
} from "@whiteboard/shared/sync";
import type { BoardRepository } from "../persistence/repository";
import type { SyncMetrics } from "./metrics";
import { RoomPersistence, type Attribution } from "./roomPersistence";

/** What a room needs from a connection. */
export interface RoomMember {
  send(message: Uint8Array): void;
  /** Who to record as the author of updates this member sends. */
  attribution(): Attribution;
  /** Closes the member's connection (e.g. the board was deleted while they were loading). */
  close(code: number, reason: string): void;
}

/** Transaction origin for documents loaded from the database: not re-persisted, not broadcast. */
export const LOAD_ORIGIN = Symbol("load");

export type RoomLoad = { ok: true } | { ok: false; reason: "deleted" | "error" };

/**
 * One board's live state: its Y.Doc, the awareness (presence) of everyone connected, and the
 * connections themselves. Document and awareness changes are broadcast to every other member;
 * document changes are also queued for durable storage.
 */
export class Room {
  readonly doc = new Y.Doc();
  readonly awareness: Awareness;
  readonly members = new Set<RoomMember>();
  /** Which member owns each awareness client id, so nobody can spoof another user's presence. */
  readonly awarenessOwners = new Map<number, RoomMember>();
  evictTimer: NodeJS.Timeout | null = null;
  persistence: RoomPersistence | null = null;
  /** The state vector known to be committed to Postgres (sent to clients as "persisted"). */
  persistedVector: Uint8Array = Y.encodeStateVector(new Y.Doc());
  /** Resolves when the document has been loaded from the database. */
  ready: Promise<RoomLoad> = Promise.resolve({ ok: true });

  constructor(readonly boardId: string) {
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
    });

    this.awareness.on(
      "update",
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        const changed = [...added, ...updated, ...removed];
        if (changed.length === 0) return;
        this.broadcast(
          encodeAwarenessMessage(encodeAwarenessUpdate(this.awareness, changed)),
          origin,
        );
      },
    );
  }

  persistedMessage(): Uint8Array {
    return encodeMessage(MESSAGE_PERSISTED, (encoder) => {
      encoding.writeVarUint8Array(encoder, this.persistedVector);
    });
  }

  markPersisted(stateVector: Uint8Array): void {
    this.persistedVector = stateVector;
    this.broadcast(this.persistedMessage(), null);
  }

  private isMember(origin: unknown): origin is RoomMember {
    return typeof origin === "object" && origin !== null && this.members.has(origin as RoomMember);
  }

  private broadcast(message: Uint8Array, except: unknown): void {
    for (const member of this.members) {
      if (member !== except) member.send(message);
    }
  }

  destroy(): void {
    if (this.evictTimer) clearTimeout(this.evictTimer);
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
}

/**
 * In-memory rooms for this instance, each backed by durable storage. Phase 5 shares rooms
 * across instances through Redis.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();

  constructor(private readonly options: RoomManagerOptions) {}

  get size(): number {
    return this.rooms.size;
  }

  get(boardId: string): Room | undefined {
    return this.rooms.get(boardId);
  }

  /** Gets or creates (and starts loading) the room, and cancels any pending eviction. */
  acquire(boardId: string): Room {
    let room = this.rooms.get(boardId);
    if (!room) {
      const created = new Room(boardId);
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

  join(room: Room, member: RoomMember): void {
    room.members.add(member);
  }

  leave(room: Room, member: RoomMember): void {
    room.members.delete(member);
    const owned = [...room.awarenessOwners]
      .filter(([, owner]) => owner === member)
      .map(([id]) => id);
    for (const id of owned) room.awarenessOwners.delete(id);
    // Tell everyone else this member's cursors are gone.
    if (owned.length > 0) removeAwarenessStates(room.awareness, owned, member);
    if (room.members.size === 0) this.scheduleEviction(room);
  }

  /**
   * Flushes and snapshots every room (graceful shutdown). Rooms keep their members; the caller
   * closes connections afterwards so the final "persisted" acknowledgements are delivered.
   */
  async flushAll(deadline: number): Promise<void> {
    await Promise.all(
      [...this.rooms.values()].map(async (room) => {
        // Rooms still loading may hold edits received before shutdown; let them apply first.
        await room.ready;
        await room.persistence?.close(deadline);
      }),
    );
  }

  destroy(): void {
    for (const room of this.rooms.values()) room.destroy();
    this.rooms.clear();
    this.options.metrics.roomsActive.set(0);
  }

  private async load(room: Room): Promise<RoomLoad> {
    const started = performance.now();
    try {
      const loaded = await this.options.repository.load(room.boardId);
      if (loaded.deleted) {
        this.drop(room);
        return { ok: false, reason: "deleted" };
      }
      Y.transact(
        room.doc,
        () => {
          if (loaded.snapshot) Y.applyUpdate(room.doc, loaded.snapshot.state, LOAD_ORIGIN);
          for (const u of loaded.updates) Y.applyUpdate(room.doc, u.update, LOAD_ORIGIN);
        },
        LOAD_ORIGIN,
      );
      room.persistedVector = Y.encodeStateVector(room.doc);
      room.persistence = new RoomPersistence({
        boardId: room.boardId,
        doc: room.doc,
        repository: this.options.repository,
        logger: this.options.logger,
        metrics: this.options.metrics,
        maxSeq: loaded.maxSeq,
        updatesSinceSnapshot: loaded.updates.length,
        flushMs: this.options.flushMs,
        snapshotEvery: this.options.snapshotEvery,
        onPersisted: (vector) => {
          room.markPersisted(vector);
        },
      });
      this.options.metrics.loadSeconds.observe((performance.now() - started) / 1000);
      return { ok: true };
    } catch (error) {
      this.options.logger.error({ err: error, boardId: room.boardId }, "failed to load board");
      this.drop(room);
      return { ok: false, reason: "error" };
    }
  }

  private scheduleEviction(room: Room): void {
    if (room.evictTimer) return;
    room.evictTimer = setTimeout(() => {
      room.evictTimer = null;
      void this.evict(room);
    }, this.options.graceMs);
    room.evictTimer.unref();
  }

  private async evict(room: Room): Promise<void> {
    if (room.members.size > 0 || this.rooms.get(room.boardId) !== room) return;
    // A room still loading may have edits waiting to be applied; let them land first.
    await room.ready;
    await room.persistence?.close(Date.now() + 10_000);
    if (room.members.size > 0) return; // Someone rejoined while we were saving.
    if ((room.persistence?.pendingCount ?? 0) > 0) {
      // Never drop unsaved edits: keep the room and try again later.
      this.options.logger.warn(
        { boardId: room.boardId },
        "eviction postponed: updates not yet persisted",
      );
      this.scheduleEviction(room);
      return;
    }
    this.drop(room);
    room.destroy();
  }

  private drop(room: Room): void {
    if (this.rooms.get(room.boardId) === room) this.rooms.delete(room.boardId);
    this.options.metrics.roomsActive.set(this.rooms.size);
  }
}
