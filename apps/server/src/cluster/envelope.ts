import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { z } from "zod";

/**
 * Messages exchanged between sync instances over a room's Redis channel. Binary, because
 * they mostly carry Yjs updates; every message names the instance that sent it so an
 * instance can ignore its own publications (Redis delivers them back to the publisher).
 */
export const CLUSTER_KINDS = {
  /** A document update applied on the sending instance (from one of its clients). */
  update: 0,
  /** An awareness (presence) update from one of the sender's clients. */
  awareness: 1,
  /** "This is my state vector": peers reply with whatever the sender is missing. */
  syncRequest: 2,
  /** Reply to a syncRequest, addressed to one instance: the update it lacks. */
  syncReply: 3,
  /** "Send me your clients' presence" (sent when a room opens on an instance). */
  awarenessRequest: 4,
  /** The room's persistence writer committed everything up to this state vector. */
  persisted: 5,
  /** The sender gave up the room's persistence lease; another instance may take it now. */
  leaseReleased: 6,
} as const;

export type ClusterKind = (typeof CLUSTER_KINDS)[keyof typeof CLUSTER_KINDS];

const KIND_VALUES = new Set<number>(Object.values(CLUSTER_KINDS));
const VERSION = 1;
/** Instance ids are UUIDs or Render instance names; anything longer is garbage. */
const MAX_INSTANCE_ID = 128;

export const clusterMessageSchema = z.object({
  from: z.string().min(1).max(MAX_INSTANCE_ID),
  kind: z.custom<ClusterKind>(
    (value) => typeof value === "number" && KIND_VALUES.has(value),
    "unknown message kind",
  ),
  payload: z.custom<Uint8Array>((value) => value instanceof Uint8Array, "payload must be bytes"),
  /** Only for syncReply: the instance the reply is for. */
  to: z.string().min(1).max(MAX_INSTANCE_ID).nullable(),
});

export type ClusterMessage = z.infer<typeof clusterMessageSchema>;

export function encodeClusterMessage(message: ClusterMessage): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeUint8(encoder, VERSION);
  encoding.writeVarString(encoder, message.from);
  encoding.writeVarUint(encoder, message.kind);
  encoding.writeVarString(encoder, message.to ?? "");
  encoding.writeVarUint8Array(encoder, message.payload);
  return encoding.toUint8Array(encoder);
}

/** Returns null for anything malformed (wrong version, bad kind, truncated, trailing bytes). */
export function decodeClusterMessage(data: Uint8Array): ClusterMessage | null {
  try {
    const decoder = decoding.createDecoder(data);
    if (decoding.readUint8(decoder) !== VERSION) return null;
    const from = decoding.readVarString(decoder);
    const kind = decoding.readVarUint(decoder);
    const to = decoding.readVarString(decoder);
    const payload = decoding.readVarUint8Array(decoder);
    if (decoding.hasContent(decoder)) return null;
    const parsed = clusterMessageSchema.safeParse({ from, kind, payload, to: to || null });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
