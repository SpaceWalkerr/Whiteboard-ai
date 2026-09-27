import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import type { ClusterMessage } from "../cluster/envelope";
import type { BoardRepository, LoadedBoard } from "../persistence/repository";
import type { Attribution, PersistedContent, RoomPersistence } from "./roomPersistence";

/** What a room needs from a connection. */
export interface RoomMember {
  send(message: Uint8Array): void;
  /** Who to record as the author of updates this member sends. */
  attribution(): Attribution;
  /** Closes the member's connection (e.g. the board was deleted while they were loading). */
  close(code: number, reason: string): void;
}

export type RoomLoad = { ok: true } | { ok: false; reason: "deleted" | "error" };

/**
 * What the RoomManager needs from a room, whatever its content: a normal board (Room, a
 * Y.Doc) or a private board (EncryptedRoom, ciphertext only). Loading, leases, cluster
 * traffic, persistence and eviction work the same for both.
 */
export interface ManagedRoom {
  readonly boardId: string;
  readonly members: Set<RoomMember>;
  evictTimer: NodeJS.Timeout | null;
  persistence: RoomPersistence | null;
  closing: boolean;
  holdsLease: boolean;
  leaseBusy: boolean;
  ready: Promise<RoomLoad>;
  readonly loaded: boolean;
  isClosing(): boolean;
  /** Applies what the database holds (before persistence starts). */
  applyLoaded(loaded: LoadedBoard): void;
  /** The content adapter for this room's write-ahead persistence. */
  createContent(repository: BoardRepository): PersistedContent;
  markPersisted(marker: Uint8Array, announce: boolean): void;
  finishLoading(): void;
  requestSync(): void;
  handleCluster(message: ClusterMessage): void;
  addMember(member: RoomMember): void;
  /** The member left: forget it and tell everyone (here and elsewhere) its presence is gone. */
  removeMember(member: RoomMember): void;
  destroy(): void;
}

/** Per-client maximum of two state vectors (also used for private rooms' peer → counter maps). */
export function mergeStateVectors(a: Uint8Array, b: Uint8Array): Uint8Array {
  const merged = Y.decodeStateVector(a);
  for (const [client, clock] of Y.decodeStateVector(b)) {
    if (clock > (merged.get(client) ?? 0)) merged.set(client, clock);
  }
  return encodeVector(merged);
}

/** Encodes a client → clock map in Yjs state-vector format. */
export function encodeVector(vector: ReadonlyMap<number, number>): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, vector.size);
  for (const [client, clock] of vector) {
    encoding.writeVarUint(encoder, client);
    encoding.writeVarUint(encoder, clock);
  }
  return encoding.toUint8Array(encoder);
}
