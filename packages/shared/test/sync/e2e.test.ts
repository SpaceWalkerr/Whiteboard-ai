import * as decoding from "lib0/decoding";
import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  base64UrlToBytes,
  bytesToBase64,
  bytesToBase64Url,
  createKeyCheck,
  decryptBytes,
  decryptText,
  DecryptionError,
  encodeClientUpdate,
  encodeEncryptedState,
  encryptBytes,
  encryptText,
  generateRoomKeyString,
  importRoomKey,
  InvalidRoomKeyError,
  isEnvelope,
  MESSAGE_ENC_STATE,
  MESSAGE_ENC_UPDATE,
  MIN_ENVELOPE_BYTES,
  randomPeerId,
  readEncryptedState,
  verifyKeyCheck,
} from "../../src/sync";

const BOARD = "20f9d63e-ea39-4eb7-8aaa-0f60d657d603";
const OTHER_BOARD = "4b7a3a0e-6c3f-4d57-9b9e-1c2d3e4f5a6b";

async function key(boardId = BOARD, encoded = generateRoomKeyString()) {
  return importRoomKey(boardId, encoded);
}

describe("room keys", () => {
  it("are 32 random bytes in unpadded base64url (fits a URL fragment)", () => {
    const encoded = generateRoomKeyString();
    expect(encoded).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(base64UrlToBytes(encoded).byteLength).toBe(32);
    expect(generateRoomKeyString()).not.toBe(encoded);
  });

  it("refuse anything that isn't exactly a 32-byte base64url key", async () => {
    for (const bad of [
      "",
      "abc",
      "not a key!",
      bytesToBase64Url(new Uint8Array(16)),
      "a".repeat(44),
    ])
      await expect(importRoomKey(BOARD, bad)).rejects.toBeInstanceOf(InvalidRoomKeyError);
  });
});

describe("envelopes", () => {
  it("round-trip, with a fresh IV every time", async () => {
    const k = await key();
    const plain = new TextEncoder().encode("Payments service → Ledger DB");
    const a = await encryptBytes(k, "update", plain);
    const b = await encryptBytes(k, "update", plain);
    expect(isEnvelope(a)).toBe(true);
    expect(a.byteLength).toBe(MIN_ENVELOPE_BYTES + plain.byteLength);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(await decryptBytes(k, "update", a)).toEqual(plain);
  });

  it("fail with the wrong key, board or kind, or after any tampering", async () => {
    const k = await key();
    const envelope = await encryptBytes(k, "update", new Uint8Array([1, 2, 3]));
    await expect(decryptBytes(await key(), "update", envelope)).rejects.toBeInstanceOf(
      DecryptionError,
    );
    // Same key bytes, other board: the associated data binds envelopes to their board.
    await expect(
      decryptBytes(await key(OTHER_BOARD, k.encoded), "update", envelope),
    ).rejects.toBeInstanceOf(DecryptionError);
    // An update can't be passed off as presence or a snapshot.
    await expect(decryptBytes(k, "awareness", envelope)).rejects.toBeInstanceOf(DecryptionError);
    await expect(decryptBytes(k, "snapshot", envelope)).rejects.toBeInstanceOf(DecryptionError);
    for (let i = 0; i < envelope.byteLength; i++) {
      const flipped = envelope.slice();
      flipped[i] = (flipped[i] ?? 0) ^ 0x01;
      await expect(decryptBytes(k, "update", flipped)).rejects.toBeInstanceOf(DecryptionError);
    }
    await expect(decryptBytes(k, "update", envelope.subarray(0, 20))).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });

  it("text round-trips and never appears in the ciphertext", async () => {
    const k = await key();
    const envelope = await encryptText(k, "title", "Checkout system — Q3");
    expect(Buffer.from(envelope).includes("Checkout")).toBe(false);
    expect(await decryptText(k, "title", envelope)).toBe("Checkout system — Q3");
  });

  it("key checks accept only the right key for the right board", async () => {
    const k = await key();
    const check = await createKeyCheck(k);
    expect(await verifyKeyCheck(k, check)).toBe(true);
    expect(await verifyKeyCheck(await key(), check)).toBe(false);
    expect(await verifyKeyCheck(await key(OTHER_BOARD, k.encoded), check)).toBe(false);
    // A title envelope is not a key check (different kind).
    expect(await verifyKeyCheck(k, await encryptText(k, "title", "x"))).toBe(false);
  });
});

describe("base64 helpers", () => {
  it("round-trip and reject malformed input", () => {
    const bytes = new Uint8Array([0, 251, 255, 62, 63, 1]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes);
    expect(() => base64ToBytes("a$==")).toThrow();
    expect(() => base64UrlToBytes("a+b/")).toThrow();
  });
});

describe("encrypted protocol", () => {
  it("encodes state and client updates", () => {
    const state = {
      snapshot: new Uint8Array([9, 9]),
      updates: [new Uint8Array([1]), new Uint8Array([2, 3])],
    };
    const decoder = decoding.createDecoder(encodeEncryptedState(state));
    expect(decoding.readVarUint(decoder)).toBe(MESSAGE_ENC_STATE);
    expect(readEncryptedState(decoder)).toEqual(state);

    const empty = decoding.createDecoder(encodeEncryptedState({ snapshot: null, updates: [] }));
    decoding.readVarUint(empty);
    expect(readEncryptedState(empty)).toEqual({ snapshot: null, updates: [] });

    const update = decoding.createDecoder(encodeClientUpdate(7, new Uint8Array([4, 5])));
    expect(decoding.readVarUint(update)).toBe(MESSAGE_ENC_UPDATE);
    expect(decoding.readVarUint(update)).toBe(7);
    expect(decoding.readVarUint8Array(update)).toEqual(new Uint8Array([4, 5]));
  });

  it("peer ids are safe integers of at most 48 bits", () => {
    for (let i = 0; i < 100; i++) {
      const id = randomPeerId();
      expect(Number.isSafeInteger(id)).toBe(true);
      expect(id).toBeLessThan(2 ** 48);
    }
  });
});
