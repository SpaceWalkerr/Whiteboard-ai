/**
 * End-to-end encryption for private boards (Phase 9). Runs in the browser and in Node 22
 * (both have WebCrypto); the server never imports the key functions, it only relays and
 * stores the envelopes.
 *
 * Key: 32 random bytes (AES-GCM-256), created in the browser when the board is created and
 * carried in the URL fragment (`#key=<base64url>`), which browsers never send to servers.
 *
 * Envelope: `version (1 byte) ‖ IV (12 random bytes) ‖ AES-GCM ciphertext + 16-byte tag`.
 * The additional authenticated data binds every envelope to its board and to what it
 * contains (`wb:e2e:v1:<kind>:<boardId>`), so the server can't move a ciphertext to another
 * board or make an awareness message pass as a document update.
 */

export const ENVELOPE_VERSION = 1;
export const ROOM_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Smallest possible envelope: header + IV + tag (empty plaintext). */
export const MIN_ENVELOPE_BYTES = 1 + IV_BYTES + TAG_BYTES;

export const CIPHER_KINDS = ["update", "snapshot", "awareness", "title", "keycheck"] as const;
export type CipherKind = (typeof CIPHER_KINDS)[number];

/** Fixed plaintext of the key check stored with the board (verifies a key before use). */
const KEY_CHECK_PLAINTEXT = "whiteboard.ai private board key check v1";

// Derived from the global WebCrypto object so this compiles against both the DOM and the
// Node type definitions (their CryptoKey/SubtleCrypto names differ).
type Subtle = typeof globalThis.crypto.subtle;
export type CryptoKeyLike = Awaited<ReturnType<Subtle["importKey"]>>;

/** A board's key, imported for use (non-extractable) plus the text form for links. */
export interface RoomKey {
  boardId: string;
  key: CryptoKeyLike;
  /** base64url of the raw key: what goes after `#key=`. */
  encoded: string;
}

export class InvalidRoomKeyError extends Error {
  constructor() {
    super("invalid room key");
    this.name = "InvalidRoomKeyError";
  }
}

/** Wrong key, wrong board/kind, or tampered/corrupt data (AES-GCM authentication failed). */
export class DecryptionError extends Error {
  constructor() {
    super("could not decrypt");
    this.name = "DecryptionError";
  }
}

function subtle(): Subtle {
  return globalThis.crypto.subtle;
}

/** A new random room key in its link form (base64url, 43 characters). */
export function generateRoomKeyString(): string {
  return bytesToBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(ROOM_KEY_BYTES)));
}

/** Imports a key from its link form. Throws InvalidRoomKeyError for anything malformed. */
export async function importRoomKey(boardId: string, encoded: string): Promise<RoomKey> {
  let raw: Uint8Array;
  try {
    raw = base64UrlToBytes(encoded);
  } catch {
    throw new InvalidRoomKeyError();
  }
  if (raw.byteLength !== ROOM_KEY_BYTES) throw new InvalidRoomKeyError();
  const key = await subtle().importKey("raw", own(raw), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  return { boardId, key, encoded };
}

/**
 * A copy backed by a plain ArrayBuffer: WebCrypto (DOM typings) refuses views that might
 * sit on a SharedArrayBuffer, and Node Buffers can be views into a shared pool.
 */
function own(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

function aad(kind: CipherKind, boardId: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`wb:e2e:v1:${kind}:${boardId}`);
}

export async function encryptBytes(
  roomKey: RoomKey,
  kind: CipherKind,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await subtle().encrypt(
      { name: "AES-GCM", iv, additionalData: aad(kind, roomKey.boardId) },
      roomKey.key,
      own(plaintext),
    ),
  );
  const envelope = new Uint8Array(1 + IV_BYTES + sealed.byteLength);
  envelope[0] = ENVELOPE_VERSION;
  envelope.set(iv, 1);
  envelope.set(sealed, 1 + IV_BYTES);
  return envelope;
}

export async function decryptBytes(
  roomKey: RoomKey,
  kind: CipherKind,
  envelope: Uint8Array,
): Promise<Uint8Array> {
  if (!isEnvelope(envelope)) throw new DecryptionError();
  try {
    const plain = await subtle().decrypt(
      {
        name: "AES-GCM",
        iv: own(envelope.subarray(1, 1 + IV_BYTES)),
        additionalData: aad(kind, roomKey.boardId),
      },
      roomKey.key,
      own(envelope.subarray(1 + IV_BYTES)),
    );
    return new Uint8Array(plain);
  } catch {
    throw new DecryptionError();
  }
}

/** Shape check only (version + minimum length); says nothing about the key. */
export function isEnvelope(bytes: Uint8Array): boolean {
  return bytes.byteLength >= MIN_ENVELOPE_BYTES && bytes[0] === ENVELOPE_VERSION;
}

export async function encryptText(roomKey: RoomKey, kind: CipherKind, text: string) {
  return encryptBytes(roomKey, kind, new TextEncoder().encode(text));
}

export async function decryptText(
  roomKey: RoomKey,
  kind: CipherKind,
  envelope: Uint8Array,
): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    await decryptBytes(roomKey, kind, envelope),
  );
}

/** Stored with a private board so a key can be verified before anything is written with it. */
export function createKeyCheck(roomKey: RoomKey): Promise<Uint8Array> {
  return encryptText(roomKey, "keycheck", KEY_CHECK_PLAINTEXT);
}

export async function verifyKeyCheck(roomKey: RoomKey, check: Uint8Array): Promise<boolean> {
  try {
    return (await decryptText(roomKey, "keycheck", check)) === KEY_CHECK_PLAINTEXT;
  } catch {
    return false;
  }
}

// --- Base64 helpers (btoa/atob exist in browsers and Node) ---

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Throws on anything that isn't strict standard base64. */
export function base64ToBytes(text: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0)
    throw new Error("invalid base64");
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Throws on anything that isn't unpadded base64url. */
export function base64UrlToBytes(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error("invalid base64url");
  const standard = text.replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
}
