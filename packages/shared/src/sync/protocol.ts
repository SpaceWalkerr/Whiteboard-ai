import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { z } from "zod";
import { presenceSchema } from "./presence";

/**
 * Wire protocol for /rooms/:boardId (compatible in spirit with y-websocket): every binary
 * message starts with a varUint type, followed by a y-protocols payload.
 */
export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;

/**
 * Largest message a client may send. Everyday updates are tiny, but a reconnecting client
 * sends its whole document in one sync step (a 2,000-shape board with history measured
 * ~1.9 MB), so 1 MB would lock large boards out. Abuse is bounded by the per-connection
 * byte-rate limit instead.
 */
export const MAX_CLIENT_MESSAGE_BYTES = 8 * 1024 * 1024;

/** Largest message a client accepts from the server (a full board on first load). */
export const MAX_SERVER_MESSAGE_BYTES = 64 * 1024 * 1024;

export const CLOSE_CODES = {
  /** Server shutting down or restarting; reconnect (possibly to another instance). */
  serviceRestart: 1012,
  /** Too many messages or bytes per second. */
  rateLimited: 1008,
  /** Message larger than MAX_CLIENT_MESSAGE_BYTES. */
  tooBig: 1009,
  /** Malformed message. */
  invalidPayload: 1007,
  /** Client could not keep up with outgoing data; reconnect and resync. */
  slowConsumer: 1013,
} as const;

/** Board ids travel in the URL path, so keep them to a safe character set. */
export const boardIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export function roomPath(boardId: string): string {
  return `/rooms/${encodeURIComponent(boardId)}`;
}

export function toUint8Array(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  return data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export function encodeMessage(
  type: number,
  write: (encoder: encoding.Encoder) => void,
): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, type);
  write(encoder);
  return encoding.toUint8Array(encoder);
}

export function encodeAwarenessMessage(update: Uint8Array): Uint8Array {
  return encodeMessage(MESSAGE_AWARENESS, (encoder) => {
    encoding.writeVarUint8Array(encoder, update);
  });
}

export interface AwarenessEntry {
  clientId: number;
  /** null means "this client left". */
  state: unknown;
}

/**
 * Decodes an awareness update (y-protocols format: count, then clientID, clock, JSON state per
 * entry) and checks every non-null state against the presence schema. Returns null when the
 * update is malformed or any state is invalid, so it can be dropped before it is applied.
 */
export function readAwarenessEntries(update: Uint8Array): AwarenessEntry[] | null {
  try {
    const decoder = decoding.createDecoder(update);
    const count = decoding.readVarUint(decoder);
    if (count > 1000) return null;
    const entries: AwarenessEntry[] = [];
    for (let i = 0; i < count; i++) {
      const clientId = decoding.readVarUint(decoder);
      decoding.readVarUint(decoder); // clock
      const state: unknown = JSON.parse(decoding.readVarString(decoder));
      if (state !== null && !presenceSchema.safeParse(state).success) return null;
      entries.push({ clientId, state });
    }
    return entries;
  } catch {
    return null;
  }
}
