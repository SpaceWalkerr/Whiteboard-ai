import { describe, expect, it } from "vitest";
import type { ArrowShape, Shape } from "@whiteboard/shared/board";
import { boundaryPoint, isOnOutline, resolveArrow } from "../geometry/arrow";
import { createArrowShape } from "../model/defaults";
import { box, rect } from "./fixtures";

function lookupOf(...shapes: Shape[]) {
  const map = new Map(shapes.map((s) => [s.id, s]));
  return (id: string) => map.get(id);
}

function arrowBetween(from: string | null, to: string | null): ArrowShape {
  return createArrowShape(
    { start: { x: -50, y: -50 }, end: { x: 900, y: 900 }, fromShapeId: from, toShapeId: to },
    { id: "arrow", zIndex: "a1", userId: "t", now: 0 },
  );
}

describe("boundaryPoint", () => {
  it("leaves a rectangle through the edge facing the target", () => {
    const r = rect("r", 0, 0, 100, 50);
    expect(boundaryPoint(r, { x: 500, y: 25 })).toEqual({ x: 100, y: 25 });
    expect(boundaryPoint(r, { x: 50, y: -300 })).toEqual({ x: 50, y: 0 });
  });

  it("lands on an ellipse outline", () => {
    const e = box("ellipse", { x: 0, y: 0, width: 200, height: 100 }, "e");
    const p = boundaryPoint(e, { x: 400, y: 400 });
    expect(isOnOutline(e, p, 0.01)).toBe(true);
  });

  it("handles rotated shapes", () => {
    const r = rect("r", 100, 100, 100, 50, { rotation: 45 });
    const p = boundaryPoint(r, { x: 1000, y: 0 });
    expect(isOnOutline(r, p, 0.01)).toBe(true);
  });

  it("does not divide by zero when the target is the centre", () => {
    const r = rect("r", 0, 0, 100, 50);
    expect(boundaryPoint(r, { x: 50, y: 25 })).toEqual({ x: 100, y: 25 });
  });
});

describe("resolveArrow", () => {
  it("attaches both ends to the facing edges of bound shapes", () => {
    const a = rect("a", 0, 0);
    const b = rect("b", 300, 0);
    const { start, end } = resolveArrow(arrowBetween("a", "b"), lookupOf(a, b));
    expect(start).toEqual({ x: 100, y: 25 });
    expect(end).toEqual({ x: 300, y: 25 });
  });

  it("follows a bound shape after it moves or resizes", () => {
    const a = rect("a", 0, 0);
    const b = rect("b", 300, 0);
    const arrow = arrowBetween("a", "b");
    const movedB = { ...b, x: 300, y: 400, w: 200, h: 80 };
    const { start, end } = resolveArrow(arrow, lookupOf(a, movedB));
    expect(isOnOutline(a, start)).toBe(true);
    expect(isOnOutline(movedB, end)).toBe(true);
  });

  it("uses fixed anchors when set", () => {
    const a = rect("a", 0, 0, 100, 50);
    const b = rect("b", 300, 0);
    const arrow = { ...arrowBetween("a", "b"), fromAnchor: { x: 0.5, y: 1 } };
    expect(resolveArrow(arrow, lookupOf(a, b)).start).toEqual({ x: 50, y: 50 });
  });

  it("keeps free ends where they were drawn", () => {
    const a = rect("a", 0, 0);
    const { start, end } = resolveArrow(arrowBetween("a", null), lookupOf(a));
    expect(end).toEqual({ x: 900, y: 900 });
    expect(isOnOutline(a, start)).toBe(true);
  });

  it("falls back to stored points when a bound shape is missing", () => {
    expect(resolveArrow(arrowBetween("gone", null), lookupOf()).start).toEqual({ x: -50, y: -50 });
  });
});
