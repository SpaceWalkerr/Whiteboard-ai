import type { Logger } from "pino";
import { Awareness, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { encodeAwarenessMessage, encodeMessage, MESSAGE_SYNC } from "@whiteboard/shared/sync";
import type { SyncMetrics } from "./metrics";

/** What a room needs from a connection. */
export interface RoomMember {
  send(message: Uint8Array): void;
}

/**
 * One board's live state: its Y.Doc, the awareness (presence) of everyone connected, and the
 * connections themselves. Document and awareness changes are broadcast to every other member.
 */
export class Room {
  readonly doc = new Y.Doc();
  readonly awareness: Awareness;
  readonly members = new Set<RoomMember>();
  /** Which member owns each awareness client id, so nobody can spoof another user's presence. */
  readonly awarenessOwners = new Map<number, RoomMember>();
  evictTimer: NodeJS.Timeout | null = null;

  constructor(readonly boardId: string) {
    this.awareness = new Awareness(this.doc);
    // The server itself has no presence.
    this.awareness.setLocalState(null);

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      const message = encodeMessage(MESSAGE_SYNC, (encoder) => {
        syncProtocol.writeUpdate(encoder, update);
      });
      this.broadcast(message, origin);
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
  /** How long an empty room stays in memory, so quick reconnects don't lose the document. */
  graceMs: number;
  metrics: SyncMetrics;
  logger: Logger;
  /** Called before an idle room is dropped. Phase 3 persists the document here. */
  onEvict?: ((boardId: string, doc: Y.Doc) => Promise<void> | void) | undefined;
}

/**
 * In-memory rooms for this instance. Phase 2 is single-instance: Phase 5 shares rooms across
 * instances through Redis.
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

  /** Gets or creates the room and cancels any pending eviction. Follow with `join`. */
  acquire(boardId: string): Room {
    let room = this.rooms.get(boardId);
    if (!room) {
      room = new Room(boardId);
      this.rooms.set(boardId, room);
      this.options.metrics.roomsActive.set(this.rooms.size);
      this.options.logger.debug({ boardId }, "room created");
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

    if (room.members.size === 0 && !room.evictTimer) {
      room.evictTimer = setTimeout(() => {
        void this.evict(room);
      }, this.options.graceMs);
      room.evictTimer.unref();
    }
  }

  private async evict(room: Room): Promise<void> {
    if (room.members.size > 0 || this.rooms.get(room.boardId) !== room) return;
    try {
      await this.options.onEvict?.(room.boardId, room.doc);
    } catch (error) {
      this.options.logger.error({ err: error, boardId: room.boardId }, "room eviction hook failed");
    }
    // Someone may have joined while the hook ran.
    if (room.members.size > 0) {
      room.evictTimer = null;
      return;
    }
    this.rooms.delete(room.boardId);
    room.destroy();
    this.options.metrics.roomsActive.set(this.rooms.size);
    this.options.logger.debug({ boardId: room.boardId }, "room evicted");
  }

  destroy(): void {
    for (const room of this.rooms.values()) room.destroy();
    this.rooms.clear();
    this.options.metrics.roomsActive.set(0);
  }
}
