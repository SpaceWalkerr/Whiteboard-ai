import { describe, expect, it } from "vitest";
import { cloneShapes, parseClipboard, serializeClipboard } from "../../src/board";
import { arrow, database, rect } from "./fixtures";

function sequentialIds() {
  let n = 0;
  return () => `new-${++n}`;
}

describe("clipboard", () => {
  it("round-trips shapes", () => {
    const shapes = [rect(), database(), arrow()];
    expect(parseClipboard(serializeClipboard(shapes))).toEqual(shapes);
  });

  it.each(["", "hello world", "{}", JSON.stringify({ kind: "whiteboard-ai/shapes", version: 2 })])(
    "ignores foreign clipboard text %j",
    (text) => {
      expect(parseClipboard(text)).toBeNull();
    },
  );

  it("rejects payloads containing an invalid shape", () => {
    const text = serializeClipboard([rect({ w: -1 })]);
    expect(parseClipboard(text)).toBeNull();
  });
});

describe("cloneShapes", () => {
  const options = {
    offset: { x: 10, y: 20 },
    zIndexKeys: ["b0", "b1", "b2", "b3"],
    userId: "me",
    now: 99,
  };

  it("assigns new ids, offsets positions and new z-order", () => {
    const original = rect({ x: 1, y: 2 });
    const [clone] = cloneShapes([original], { ...options, newId: sequentialIds() });
    expect(clone).toMatchObject({ id: "new-1", x: 11, y: 22, zIndex: "b0", createdBy: "me" });
  });

  it("re-binds arrows between copied shapes and unbinds the rest", () => {
    const a = rect();
    const b = rect();
    const outside = rect();
    const inner = arrow({ fromShapeId: a.id, toShapeId: b.id, fromAnchor: { x: 1, y: 0.5 } });
    const dangling = arrow({ fromShapeId: a.id, toShapeId: outside.id, toAnchor: { x: 0, y: 0 } });

    const clones = cloneShapes([a, b, inner, dangling], { ...options, newId: sequentialIds() });
    const [ca, cb, cInner, cDangling] = clones;

    expect(cInner).toMatchObject({
      fromShapeId: ca?.id,
      toShapeId: cb?.id,
      fromAnchor: { x: 1, y: 0.5 },
    });
    expect(cDangling).toMatchObject({ fromShapeId: ca?.id, toShapeId: null, toAnchor: "auto" });
    expect(cDangling?.type === "arrow" && cDangling.end).toEqual({
      x: dangling.end.x + 10,
      y: dangling.end.y + 20,
    });
  });

  it("gives each copied group a fresh shared group id", () => {
    const a = rect({ groupId: "g1" });
    const b = rect({ groupId: "g1" });
    const c = rect({ groupId: null });
    const [ca, cb, cc] = cloneShapes([a, b, c], { ...options, newId: sequentialIds() });
    expect(ca?.groupId).toBeTruthy();
    expect(ca?.groupId).not.toBe("g1");
    expect(cb?.groupId).toBe(ca?.groupId);
    expect(cc?.groupId).toBeNull();
  });
});
