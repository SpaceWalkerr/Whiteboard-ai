import type { Shape } from "@whiteboard/shared/board";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEG_TO_RAD = Math.PI / 180;

export function rotatePoint(point: Point, origin: Point, degrees: number): Point {
  if (degrees === 0) return point;
  const rad = degrees * DEG_TO_RAD;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  return { x: origin.x + dx * cos - dy * sin, y: origin.y + dx * sin + dy * cos };
}

/** Local shape coordinates (0..w, 0..h) → world coordinates. */
export function toWorld(shape: Shape, local: Point): Point {
  return rotatePoint({ x: shape.x + local.x, y: shape.y + local.y }, shape, shape.rotation);
}

/** World coordinates → local shape coordinates. */
export function toLocal(shape: Shape, world: Point): Point {
  const unrotated = rotatePoint(world, shape, -shape.rotation);
  return { x: unrotated.x - shape.x, y: unrotated.y - shape.y };
}

export function shapeCenter(shape: Shape): Point {
  return toWorld(shape, { x: shape.w / 2, y: shape.h / 2 });
}

/** Axis-aligned bounds of a (possibly rotated) box shape. Arrows: see arrowBounds. */
export function boxBounds(shape: Shape): Rect {
  if (shape.rotation === 0) return { x: shape.x, y: shape.y, width: shape.w, height: shape.h };
  const corners = [
    toWorld(shape, { x: 0, y: 0 }),
    toWorld(shape, { x: shape.w, y: 0 }),
    toWorld(shape, { x: shape.w, y: shape.h }),
    toWorld(shape, { x: 0, y: shape.h }),
  ];
  return boundsOfPoints(corners);
}

export function boundsOfPoints(points: readonly Point[]): Rect {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function unionRects(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  return boundsOfPoints(
    rects.flatMap((r) => [
      { x: r.x, y: r.y },
      { x: r.x + r.width, y: r.y + r.height },
    ]),
  );
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
  );
}

export function expandRect(rect: Rect, by: number): Rect {
  return {
    x: rect.x - by,
    y: rect.y - by,
    width: rect.width + by * 2,
    height: rect.height + by * 2,
  };
}

/** Normalizes a rect dragged from `a` to `b` in any direction. */
export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}
