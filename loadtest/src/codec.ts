/**
 * Minimal encoder/decoder for our sync protocol, with no dependencies, so each of thousands
 * of k6 virtual users stays tiny (bundling Yjs into every VU costs megabytes each). It
 * produces genuine Yjs v1 updates: the server applies them with Yjs like any browser edit,
 * and test/codec.test.ts checks them against Yjs itself.
 *
 * Each virtual user edits one key of a root map (like repeatedly moving one shape): the
 * first set has no origin, every later one has the previous value as its left origin,
 * exactly what Y.Map#set produces.
 */

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_PERSISTED = 2;
const SYNC_UPDATE = 2;
const CONTENT_ANY = 8;
const HAS_ORIGIN = 0x80;
const HAS_PARENT_SUB = 0x20;
const ANY_STRING = 119;

class Writer {
  private readonly bytes: number[] = [];

  uint8(value: number): this {
    this.bytes.push(value & 0xff);
    return this;
  }

  varUint(value: number): this {
    let n = value;
    while (n > 0x7f) {
      this.bytes.push(0x80 | (n & 0x7f));
      n = Math.floor(n / 128);
    }
    this.bytes.push(n);
    return this;
  }

  /** ASCII only (all our load-test strings are). */
  varString(value: string): this {
    this.varUint(value.length);
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code > 0x7f) throw new Error("load-test strings must be ASCII");
      this.bytes.push(code);
    }
    return this;
  }

  varBytes(value: Uint8Array): this {
    this.varUint(value.length);
    for (const byte of value) this.bytes.push(byte);
    return this;
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

export interface MapSet {
  clientId: number;
  /** This client's clock: 0 for its first edit, then +1 per edit. */
  clock: number;
  rootName: string;
  key: string;
  value: string;
}

/** A Yjs v1 update equivalent to `doc.getMap(rootName).set(key, value)`. */
export function encodeMapSet({ clientId, clock, rootName, key, value }: MapSet): Uint8Array {
  const w = new Writer();
  w.varUint(1); // clients with structs
  w.varUint(1); // structs for this client
  w.varUint(clientId);
  w.varUint(clock);
  if (clock === 0) {
    w.uint8(CONTENT_ANY | HAS_PARENT_SUB);
    w.varUint(1); // parent is a root type, by name
    w.varString(rootName);
    w.varString(key);
  } else {
    // Left origin = our previous value for this key; parent and key are implied by it.
    w.uint8(CONTENT_ANY | HAS_ORIGIN | HAS_PARENT_SUB);
    w.varUint(clientId);
    w.varUint(clock - 1);
  }
  w.varUint(1); // one value
  w.uint8(ANY_STRING);
  w.varString(value);
  if (clock === 0) {
    w.varUint(0); // empty delete set
  } else {
    // Delete set: the value this one replaces (as Yjs writes it).
    w.varUint(1)
      .varUint(clientId)
      .varUint(1)
      .varUint(clock - 1)
      .varUint(1);
  }
  return w.toBytes();
}

/** Wire message carrying a document update. */
export function syncUpdateMessage(update: Uint8Array): Uint8Array {
  return new Writer().varUint(MESSAGE_SYNC).varUint(SYNC_UPDATE).varBytes(update).toBytes();
}

/** Wire message carrying one client's awareness (presence) state. */
export function awarenessMessage(clientId: number, clock: number, state: unknown): Uint8Array {
  const update = new Writer()
    .varUint(1)
    .varUint(clientId)
    .varUint(clock)
    .varString(JSON.stringify(state))
    .toBytes();
  return new Writer().varUint(MESSAGE_AWARENESS).varBytes(update).toBytes();
}

export function presence(userId: string, name: string, x: number, y: number) {
  return {
    user: { id: userId, name, color: "#1d4ed8" },
    cursor: { x, y },
    selection: [],
    viewport: null,
  };
}

/** Marker embedded in every load-test edit, so receivers can time it without decoding Yjs. */
export function marker(vu: number, seq: number, sentAt: number): string {
  return `lt|${vu}|${seq}|${sentAt}|`;
}

export interface SeenMarker {
  vu: number;
  seq: number;
  sentAt: number;
}

const MARKER = /lt\|(\d+)\|(\d+)\|(\d+)\|/g;

/** All markers in a message (updates may be merged, so there can be several). */
export function findMarkers(bytes: Uint8Array): SeenMarker[] {
  let text = "";
  for (let i = 0; i < bytes.length; i += 4096) {
    text += String.fromCharCode(...bytes.subarray(i, i + 4096));
  }
  const found: SeenMarker[] = [];
  for (const match of text.matchAll(MARKER)) {
    found.push({ vu: Number(match[1]), seq: Number(match[2]), sentAt: Number(match[3]) });
  }
  return found;
}

class Reader {
  private pos = 0;
  constructor(private readonly bytes: Uint8Array) {}

  varUint(): number {
    let result = 0;
    let multiplier = 1;
    for (;;) {
      const byte = this.bytes[this.pos++];
      if (byte === undefined) throw new Error("truncated");
      result += (byte & 0x7f) * multiplier;
      if (byte < 0x80) return result;
      multiplier *= 128;
    }
  }

  varBytes(): Uint8Array {
    const length = this.varUint();
    const out = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }
}

/** Message type of a server message (0 sync, 1 awareness, 2 persisted). */
export function messageType(bytes: Uint8Array): number {
  return new Reader(bytes).varUint();
}

/** For a "persisted" message: the committed clock of `clientId` (0 if none). */
export function persistedClock(bytes: Uint8Array, clientId: number): number | null {
  const reader = new Reader(bytes);
  if (reader.varUint() !== MESSAGE_PERSISTED) return null;
  const vector = new Reader(reader.varBytes());
  const count = vector.varUint();
  for (let i = 0; i < count; i++) {
    const client = vector.varUint();
    const clock = vector.varUint();
    if (client === clientId) return clock;
  }
  return 0;
}
