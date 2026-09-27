import { expect } from "vitest";
import * as Y from "yjs";
import { isEnvelope } from "@whiteboard/shared/sync";

/** True when `bytes` contains `needle` anywhere. */
function contains(bytes: Uint8Array, needle: Uint8Array): boolean {
  return Buffer.from(bytes).indexOf(Buffer.from(needle)) !== -1;
}

/** What Yjs makes of the bytes: null when they aren't a Yjs update at all. */
function asYjs(bytes: Uint8Array): { shapes: number; structs: number } | null {
  try {
    const decoded = Y.decodeUpdate(bytes);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, bytes);
    const result = { shapes: doc.getMap("shapes").size, structs: decoded.structs.length };
    doc.destroy();
    return result;
  } catch {
    return null;
  }
}

/**
 * Stored bytes of a private board must be opaque: each one an AES-GCM envelope, not
 * something Yjs can turn into board content, and none containing any of `labels` as UTF-8,
 * UTF-16 or base64 text.
 */
export function assertOpaque(blobs: readonly Uint8Array[], labels: readonly string[]): void {
  expect(blobs.length).toBeGreaterThan(0);
  for (const blob of blobs) {
    expect(isEnvelope(blob)).toBe(true);
    const yjs = asYjs(blob);
    // Either not decodable at all, or nothing a board could be made of.
    if (yjs !== null) expect(yjs.shapes).toBe(0);
    for (const label of labels) {
      expect(contains(blob, Buffer.from(label, "utf8"))).toBe(false);
      expect(contains(blob, Buffer.from(label, "utf16le"))).toBe(false);
      expect(contains(blob, Buffer.from(Buffer.from(label).toString("base64")))).toBe(false);
    }
  }
}

/** Plaintext positive control: proves `assertOpaque` would catch a readable update. */
export function readableUpdate(label: string): Uint8Array {
  const doc = new Y.Doc();
  const shape = new Y.Map<unknown>();
  doc.getMap("shapes").set("s", shape);
  shape.set("label", label);
  return Y.encodeStateAsUpdate(doc);
}
