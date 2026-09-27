import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { encodeMessage } from "./protocol";

/**
 * Wire protocol for private (end-to-end encrypted) rooms. Every document update, snapshot
 * and presence message is an opaque envelope (see e2e.ts) that the server relays and
 * stores without being able to read it. The plaintext y-protocols messages (MESSAGE_SYNC,
 * MESSAGE_AWARENESS) are refused in these rooms, and these messages in normal rooms.
 *
 * "Saved" reuses MESSAGE_PERSISTED: in a private room its vector maps each connection's
 * peer id to the highest update counter `n` committed to the database.
 */

/** Server → client, first message: this connection's peer id (random, per connection). */
export const MESSAGE_ENC_WELCOME = 4;
/** Server → client: the stored board — latest encrypted snapshot + every update after it. */
export const MESSAGE_ENC_STATE = 5;
/** Client → server: counter `n` + envelope. Server → client: envelope. */
export const MESSAGE_ENC_UPDATE = 6;
/** Client → server: envelope. Server → client: the sender's peer id + envelope. */
export const MESSAGE_ENC_AWARENESS = 7;
/** Server → client: a peer disconnected (drop the presence it sent). */
export const MESSAGE_ENC_PEER_LEFT = 8;
/**
 * Server → client (one editor): "send an encrypted snapshot of your document; it replaces
 * every stored update up to `seqUpto`". The server can't merge ciphertext, so clients
 * compact for it. Everything up to `seqUpto` was sent to this client before this request.
 */
export const MESSAGE_ENC_SNAPSHOT_REQUEST = 9;
/** Client → server: reply to a snapshot request (request id + envelope). */
export const MESSAGE_ENC_SNAPSHOT = 10;

export interface EncryptedState {
  snapshot: Uint8Array | null;
  updates: Uint8Array[];
}

export function encodeWelcome(peerId: number): Uint8Array {
  return encodeMessage(MESSAGE_ENC_WELCOME, (e) => {
    encoding.writeVarUint(e, peerId);
  });
}

export function encodeEncryptedState(state: EncryptedState): Uint8Array {
  return encodeMessage(MESSAGE_ENC_STATE, (e) => {
    encoding.writeVarUint8Array(e, state.snapshot ?? new Uint8Array());
    encoding.writeVarUint(e, state.updates.length);
    for (const update of state.updates) encoding.writeVarUint8Array(e, update);
  });
}

export function readEncryptedState(decoder: decoding.Decoder): EncryptedState {
  const snapshot = decoding.readVarUint8Array(decoder);
  const count = decoding.readVarUint(decoder);
  const updates: Uint8Array[] = [];
  for (let i = 0; i < count; i++) updates.push(decoding.readVarUint8Array(decoder));
  return { snapshot: snapshot.byteLength > 0 ? snapshot : null, updates };
}

export function encodeClientUpdate(n: number, envelope: Uint8Array): Uint8Array {
  return encodeMessage(MESSAGE_ENC_UPDATE, (e) => {
    encoding.writeVarUint(e, n);
    encoding.writeVarUint8Array(e, envelope);
  });
}

export function encodeServerUpdate(envelope: Uint8Array): Uint8Array {
  return encodeMessage(MESSAGE_ENC_UPDATE, (e) => {
    encoding.writeVarUint8Array(e, envelope);
  });
}

export function encodeClientAwareness(envelope: Uint8Array): Uint8Array {
  return encodeMessage(MESSAGE_ENC_AWARENESS, (e) => {
    encoding.writeVarUint8Array(e, envelope);
  });
}

export function encodeServerAwareness(peerId: number, envelope: Uint8Array): Uint8Array {
  return encodeMessage(MESSAGE_ENC_AWARENESS, (e) => {
    encoding.writeVarUint(e, peerId);
    encoding.writeVarUint8Array(e, envelope);
  });
}

export function encodePeerLeft(peerId: number): Uint8Array {
  return encodeMessage(MESSAGE_ENC_PEER_LEFT, (e) => {
    encoding.writeVarUint(e, peerId);
  });
}

export function encodeSnapshotRequest(requestId: number, seqUpto: number): Uint8Array {
  return encodeMessage(MESSAGE_ENC_SNAPSHOT_REQUEST, (e) => {
    encoding.writeVarUint(e, requestId);
    encoding.writeVarUint(e, seqUpto);
  });
}

export function encodeSnapshotReply(requestId: number, envelope: Uint8Array): Uint8Array {
  return encodeMessage(MESSAGE_ENC_SNAPSHOT, (e) => {
    encoding.writeVarUint(e, requestId);
    encoding.writeVarUint8Array(e, envelope);
  });
}

/** Random id that fits a varUint and a JS number exactly (48 bits). */
export function randomPeerId(): number {
  const [high = 0, low = 0] = globalThis.crypto.getRandomValues(new Uint32Array(2));
  return (high & 0xffff) * 0x1_0000_0000 + low;
}
