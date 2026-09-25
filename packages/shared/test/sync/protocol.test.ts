import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { backoffDelay, boardIdSchema, readAwarenessEntries } from "../../src/sync";

const presence = {
  user: { id: "u1", name: "Ada", color: "#1d4ed8" },
  cursor: { x: 1, y: 2 },
  selection: ["s1"],
  viewport: null,
};

function awarenessUpdate(state: unknown): Uint8Array {
  const awareness = new Awareness(new Y.Doc());
  awareness.setLocalState(state as Record<string, unknown> | null);
  return encodeAwarenessUpdate(awareness, [awareness.clientID]);
}

describe("readAwarenessEntries", () => {
  it("accepts valid presence and removals", () => {
    expect(readAwarenessEntries(awarenessUpdate(presence))?.[0]?.state).toEqual(presence);
    expect(readAwarenessEntries(awarenessUpdate(null))?.[0]?.state).toBeNull();
  });

  it("rejects presence that fails the schema", () => {
    expect(
      readAwarenessEntries(
        awarenessUpdate({ ...presence, user: { ...presence.user, color: "red" } }),
      ),
    ).toBeNull();
    expect(readAwarenessEntries(awarenessUpdate({ hello: "world" }))).toBeNull();
  });

  it("rejects malformed bytes", () => {
    expect(readAwarenessEntries(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe("backoffDelay", () => {
  const options = { initialMs: 500, maxMs: 30_000 };

  it("doubles per attempt with jitter between half and full delay", () => {
    expect(backoffDelay(0, options, () => 0)).toBe(250);
    expect(backoffDelay(0, options, () => 1)).toBe(500);
    expect(backoffDelay(3, options, () => 1)).toBe(4000);
  });

  it("is capped", () => {
    expect(backoffDelay(50, options, () => 1)).toBe(30_000);
  });
});

describe("boardIdSchema", () => {
  it("accepts UUIDs and rejects anything else", () => {
    expect(boardIdSchema.safeParse("20f9d63e-ea39-4eb7-8aaa-0f60d657d603").success).toBe(true);
    expect(boardIdSchema.safeParse("3f2a-b_C9").success).toBe(false);
    expect(boardIdSchema.safeParse("../etc").success).toBe(false);
    expect(boardIdSchema.safeParse("").success).toBe(false);
  });
});
