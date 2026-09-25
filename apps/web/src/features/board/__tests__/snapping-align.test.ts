import { describe, expect, it } from "vitest";
import { alignDeltas, distributeDeltas } from "../interaction/align";
import { snapRect, snapToGrid } from "../interaction/snapping";
import { simplifyPoints } from "../geometry/simplify";

describe("snapRect", () => {
  const other = { x: 200, y: 0, width: 100, height: 100 };

  it("snaps a nearby left edge to another shape's left edge and reports a guide", () => {
    const result = snapRect({ x: 203, y: 300, width: 50, height: 50 }, [other], 6);
    expect(result.dx).toBe(-3);
    expect(result.guides).toContainEqual({
      orientation: "vertical",
      position: 200,
      from: 0,
      to: 350,
    });
  });

  it("snaps centres", () => {
    const result = snapRect({ x: 0, y: 26, width: 50, height: 50 }, [other], 6);
    expect(result.dy).toBe(-1);
  });

  it("does not snap beyond the threshold", () => {
    // Edges/centre at 215, 220, 225: the nearest line of `other` (200) is 15px away.
    expect(snapRect({ x: 215, y: 300, width: 10, height: 50 }, [other], 6)).toMatchObject({
      dx: 0,
      dy: 0,
    });
  });

  it("rounds to the grid", () => {
    expect(snapToGrid(29, 20)).toBe(20);
    expect(snapToGrid(31, 20)).toBe(40);
  });
});

describe("alignment", () => {
  const units = [
    { key: "a", bounds: { x: 0, y: 0, width: 100, height: 50 } },
    { key: "b", bounds: { x: 300, y: 100, width: 50, height: 50 } },
    { key: "c", bounds: { x: 120, y: 40, width: 40, height: 20 } },
  ];

  it("aligns left edges to the leftmost unit", () => {
    const deltas = alignDeltas(units, "left");
    expect(deltas.get("b")).toEqual({ dx: -300, dy: 0 });
    expect(deltas.has("a")).toBe(false);
  });

  it("aligns vertical centres", () => {
    const deltas = alignDeltas(units, "middle");
    // Combined bounds 0..150, middle 75.
    expect(deltas.get("a")).toEqual({ dx: 0, dy: 50 });
  });

  it("distributes with equal gaps and keeps the outer units in place", () => {
    const deltas = distributeDeltas(units, "horizontal");
    // Span 0..350, occupied 190, gap 80 → c moves to x=180.
    expect(deltas.get("c")).toEqual({ dx: 60, dy: 0 });
    expect(deltas.has("a")).toBe(false);
    expect(deltas.has("b")).toBe(false);
  });

  it("needs at least three units to distribute", () => {
    expect(distributeDeltas(units.slice(0, 2), "vertical").size).toBe(0);
  });
});

describe("simplifyPoints", () => {
  it("drops points on a straight line", () => {
    expect(simplifyPoints([0, 0, 1, 1, 2, 2, 3, 3], 0.5)).toEqual([0, 0, 3, 3]);
  });

  it("keeps corners", () => {
    expect(simplifyPoints([0, 0, 5, 0, 10, 0, 10, 5, 10, 10], 0.5)).toEqual([0, 0, 10, 0, 10, 10]);
  });
});
