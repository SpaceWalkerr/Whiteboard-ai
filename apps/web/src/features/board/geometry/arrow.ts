import type { ArrowShape, Shape } from "@whiteboard/shared/board";
import { boundsOfPoints, shapeCenter, toLocal, toWorld, type Point, type Rect } from "./bounds";

export interface ArrowGeometry {
  start: Point;
  end: Point;
}

export type ShapeLookup = (id: string) => Shape | undefined;

/**
 * Where an arrow's ends are right now. Bound ends are recomputed from the bound shape on
 * every call — that is how arrows "follow" shapes without storing positions twice.
 */
export function resolveArrow(arrow: ArrowShape, lookup: ShapeLookup): ArrowGeometry {
  const from = boundShape(arrow.fromShapeId, lookup);
  const to = boundShape(arrow.toShapeId, lookup);

  // The reference point each "auto" end aims at: the other shape's centre, or the other
  // free end. Using centres (not resolved ends) avoids a circular dependency.
  const fromRef = from ? shapeCenter(from) : arrow.start;
  const toRef = to ? shapeCenter(to) : arrow.end;

  return {
    start: from ? anchorPoint(from, arrow.fromAnchor, toRef) : arrow.start,
    end: to ? anchorPoint(to, arrow.toAnchor, fromRef) : arrow.end,
  };
}

function boundShape(id: string | null, lookup: ShapeLookup): Shape | undefined {
  if (id === null) return undefined;
  const shape = lookup(id);
  return shape && shape.type !== "arrow" ? shape : undefined;
}

function anchorPoint(shape: Shape, anchor: ArrowShape["fromAnchor"], towards: Point): Point {
  if (anchor === "auto") return boundaryPoint(shape, towards);
  return toWorld(shape, { x: anchor.x * shape.w, y: anchor.y * shape.h });
}

/**
 * Point where the ray from the shape's centre towards `target` leaves the shape outline.
 * Works in the shape's local (unrotated) space, so rotation is handled exactly.
 */
export function boundaryPoint(shape: Shape, target: Point): Point {
  const rx = shape.w / 2;
  const ry = shape.h / 2;
  if (rx === 0 || ry === 0) return shapeCenter(shape);

  const local = toLocal(shape, target);
  let dx = local.x - rx;
  let dy = local.y - ry;
  if (dx === 0 && dy === 0) {
    dx = 1;
    dy = 0;
  }

  let t: number;
  if (shape.type === "ellipse") {
    t = 1 / Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2);
  } else {
    t = Math.min(
      dx === 0 ? Number.POSITIVE_INFINITY : rx / Math.abs(dx),
      dy === 0 ? Number.POSITIVE_INFINITY : ry / Math.abs(dy),
    );
  }
  return toWorld(shape, { x: rx + dx * t, y: ry + dy * t });
}

/** True if `point` lies on the shape's outline (within `tolerance` world units). */
export function isOnOutline(shape: Shape, point: Point, tolerance = 0.5): boolean {
  const p = toLocal(shape, point);
  if (shape.type === "ellipse") {
    const rx = shape.w / 2;
    const ry = shape.h / 2;
    const scaled = Math.hypot((p.x - rx) / rx, (p.y - ry) / ry);
    return Math.abs(scaled - 1) * Math.min(rx, ry) <= tolerance;
  }
  const insideX = p.x >= -tolerance && p.x <= shape.w + tolerance;
  const insideY = p.y >= -tolerance && p.y <= shape.h + tolerance;
  const onVertical =
    insideY && (Math.abs(p.x) <= tolerance || Math.abs(p.x - shape.w) <= tolerance);
  const onHorizontal =
    insideX && (Math.abs(p.y) <= tolerance || Math.abs(p.y - shape.h) <= tolerance);
  return onVertical || onHorizontal;
}

export function arrowBounds(geometry: ArrowGeometry): Rect {
  return boundsOfPoints([geometry.start, geometry.end]);
}

/** Bounding-box fields stored on an arrow for its free-end points. */
export function arrowBoxFields(
  start: Point,
  end: Point,
): { x: number; y: number; w: number; h: number } {
  const b = boundsOfPoints([start, end]);
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}
