import { describe, expect, it } from "vitest";
import {
  clampScale,
  cullRect,
  detailLevel,
  fitRect,
  MAX_SCALE,
  MIN_SCALE,
  screenToWorld,
  visibleWorldRect,
  worldToScreen,
  zoomAt,
} from "../viewport/viewport";

describe("viewport maths", () => {
  const vp = { x: 100, y: 50, scale: 2 };

  it("converts between screen and world coordinates", () => {
    const world = screenToWorld(vp, { x: 300, y: 250 });
    expect(world).toEqual({ x: 100, y: 100 });
    expect(worldToScreen(vp, world)).toEqual({ x: 300, y: 250 });
  });

  it("zooms around the cursor without moving the point under it", () => {
    const cursor = { x: 400, y: 300 };
    const before = screenToWorld(vp, cursor);
    const zoomed = zoomAt(vp, cursor, 3);
    expect(screenToWorld(zoomed, cursor)).toEqual(before);
  });

  it("clamps zoom", () => {
    expect(clampScale(100)).toBe(MAX_SCALE);
    expect(clampScale(0)).toBe(MIN_SCALE);
  });

  it("fits a rect in the centre of the screen without zooming past 100%", () => {
    const fitted = fitRect({ x: 0, y: 0, width: 100, height: 100 }, { width: 1000, height: 800 });
    expect(fitted.scale).toBe(1);
    expect(worldToScreen(fitted, { x: 50, y: 50 })).toEqual({ x: 500, y: 400 });
  });

  it("culls to an area that covers the screen and only changes in coarse steps", () => {
    const size = { width: 1000, height: 800 };
    const vp = { x: -100, y: -100, scale: 1 };
    const visible = visibleWorldRect(vp, size);
    const cull = cullRect(vp, size);
    expect(cull.x).toBeLessThanOrEqual(visible.x);
    expect(cull.x + cull.width).toBeGreaterThanOrEqual(visible.x + visible.width);
    // A small pan does not change the cull rect.
    expect(cullRect({ x: -110, y: -110, scale: 1 }, size)).toEqual(cull);
  });

  it("drops detail when zoomed far out", () => {
    expect(detailLevel(1)).toBe("full");
    expect(detailLevel(0.2)).toBe("low");
  });
});
