import { describe, expect, it } from "vitest";
import { compareOrder, reorderKeys, type Ordered } from "../../src/board";

function board(...ids: string[]): Ordered[] {
  // Keys in ascending order: a0, a1, ...
  return ids.map((id, index) => ({ id, zIndex: `a${index}` }));
}

function apply(ordered: Ordered[], keys: Map<string, string>): string[] {
  return ordered
    .map((s) => ({ ...s, zIndex: keys.get(s.id) ?? s.zIndex }))
    .sort(compareOrder)
    .map((s) => s.id);
}

describe("reorderKeys", () => {
  const shapes = board("a", "b", "c", "d");

  it("brings shapes to the front keeping their relative order", () => {
    expect(apply(shapes, reorderKeys(shapes, new Set(["a", "c"]), "front"))).toEqual([
      "b",
      "d",
      "a",
      "c",
    ]);
  });

  it("sends shapes to the back", () => {
    expect(apply(shapes, reorderKeys(shapes, new Set(["d"]), "back"))).toEqual([
      "d",
      "a",
      "b",
      "c",
    ]);
  });

  it("moves forward one step past the next unselected shape", () => {
    expect(apply(shapes, reorderKeys(shapes, new Set(["a"]), "forward"))).toEqual([
      "b",
      "a",
      "c",
      "d",
    ]);
  });

  it("moves backward one step", () => {
    expect(apply(shapes, reorderKeys(shapes, new Set(["c"]), "backward"))).toEqual([
      "a",
      "c",
      "b",
      "d",
    ]);
  });

  it("only assigns keys to shapes that move", () => {
    const keys = reorderKeys(shapes, new Set(["b"]), "front");
    expect([...keys.keys()]).toEqual(["b"]);
  });

  it("renumbers when neighbours share a key after concurrent edits", () => {
    const clashing: Ordered[] = [
      { id: "a", zIndex: "a0" },
      { id: "b", zIndex: "a0" },
      { id: "c", zIndex: "a1" },
    ];
    const keys = reorderKeys(clashing, new Set(["c"]), "backward");
    expect(apply(clashing, keys)).toEqual(["a", "c", "b"]);
  });

  it("breaks zIndex ties by id so every client renders the same order", () => {
    const tied = [
      { id: "b", zIndex: "a0" },
      { id: "a", zIndex: "a0" },
    ];
    expect([...tied].sort(compareOrder).map((s) => s.id)).toEqual(["a", "b"]);
  });
});
