import type { Point, Rect } from "../geometry/bounds";

/** Stage transform: screen = world * scale + (x, y). */
export interface Viewport {
  x: number;
  y: number;
  scale: number;
}

export interface Size {
  width: number;
  height: number;
}

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 4;

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function screenToWorld(vp: Viewport, p: Point): Point {
  return { x: (p.x - vp.x) / vp.scale, y: (p.y - vp.y) / vp.scale };
}

export function worldToScreen(vp: Viewport, p: Point): Point {
  return { x: p.x * vp.scale + vp.x, y: p.y * vp.scale + vp.y };
}

/** Zooms so the world point under `screenPoint` stays under it. */
export function zoomAt(vp: Viewport, screenPoint: Point, nextScale: number): Viewport {
  const scale = clampScale(nextScale);
  const world = screenToWorld(vp, screenPoint);
  return { scale, x: screenPoint.x - world.x * scale, y: screenPoint.y - world.y * scale };
}

export function panBy(vp: Viewport, dx: number, dy: number): Viewport {
  return { ...vp, x: vp.x + dx, y: vp.y + dy };
}

export function visibleWorldRect(vp: Viewport, size: Size): Rect {
  return {
    x: -vp.x / vp.scale,
    y: -vp.y / vp.scale,
    width: size.width / vp.scale,
    height: size.height / vp.scale,
  };
}

/** Viewport that fits `rect` inside `size` with padding, never zooming in past `maxScale`. */
export function fitRect(rect: Rect, size: Size, padding = 64, maxScale = 1): Viewport {
  const availableW = Math.max(1, size.width - padding * 2);
  const availableH = Math.max(1, size.height - padding * 2);
  const scale = clampScale(
    Math.min(maxScale, availableW / Math.max(1, rect.width), availableH / Math.max(1, rect.height)),
  );
  return {
    scale,
    x: size.width / 2 - (rect.x + rect.width / 2) * scale,
    y: size.height / 2 - (rect.y + rect.height / 2) * scale,
  };
}

/**
 * The world rect shapes are culled against: the visible area plus half a screen of margin,
 * snapped outward to a coarse grid. Snapping means it only changes every half screen of
 * panning, so React re-renders the shape list rarely while the stage itself moves every frame.
 */
export function cullRect(vp: Viewport, size: Size): Rect {
  const visible = visibleWorldRect(vp, size);
  const step = Math.max(visible.width, visible.height) / 2;
  const margin = step;
  const x0 = Math.floor((visible.x - margin) / step) * step;
  const y0 = Math.floor((visible.y - margin) / step) * step;
  const x1 = Math.ceil((visible.x + visible.width + margin) / step) * step;
  const y1 = Math.ceil((visible.y + visible.height + margin) / step) * step;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export type DetailLevel = "full" | "low";

/** Below this zoom, icons and small text are unreadable; skip drawing them. */
export function detailLevel(scale: number): DetailLevel {
  return scale < 0.35 ? "low" : "full";
}
