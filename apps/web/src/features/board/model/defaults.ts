import type {
  ArrowShape,
  Shape,
  ShapeStyle,
  ShapeType,
  SystemShapeType,
} from "@whiteboard/shared/board";
import { isSystemShapeType } from "@whiteboard/shared/board";
import type { Point, Rect } from "../geometry/bounds";
import { arrowBoxFields } from "../geometry/arrow";
import { SYSTEM_SHAPE_META } from "./systemShapes";

export const DEFAULT_SIZES: Record<
  Exclude<ShapeType, "arrow" | "freehand">,
  { w: number; h: number }
> = {
  rectangle: { w: 160, h: 100 },
  ellipse: { w: 160, h: 100 },
  text: { w: 240, h: 28 },
  sticky: { w: 200, h: 200 },
  client: { w: 160, h: 96 },
  cdn: { w: 160, h: 96 },
  load_balancer: { w: 160, h: 96 },
  api_gateway: { w: 160, h: 96 },
  service: { w: 160, h: 96 },
  database: { w: 160, h: 96 },
  cache: { w: 160, h: 96 },
  queue: { w: 160, h: 96 },
  object_storage: { w: 160, h: 96 },
  search_index: { w: 160, h: 96 },
  worker: { w: 160, h: 96 },
  external_api: { w: 160, h: 96 },
};

const baseStyle: ShapeStyle = {
  fill: "#ffffff",
  stroke: "#1f2937",
  strokeWidth: 2,
  strokeStyle: "solid",
  fontSize: 16,
  opacity: 1,
};

export function defaultStyle(type: ShapeType): ShapeStyle {
  switch (type) {
    case "text":
      return { ...baseStyle, fill: "transparent", strokeWidth: 0, fontSize: 20 };
    case "sticky":
      return { ...baseStyle, fill: "#fef08a", strokeWidth: 0, fontSize: 18 };
    case "freehand":
      return { ...baseStyle, fill: "transparent", strokeWidth: 3 };
    case "arrow":
      return { ...baseStyle, fill: "transparent", strokeWidth: 2, fontSize: 14 };
    default:
      return baseStyle;
  }
}

export interface NewShapeContext {
  id: string;
  zIndex: string;
  userId: string;
  now: number;
}

export type BoxShapeType = Exclude<ShapeType, "arrow" | "freehand">;

/** A new box-like shape filling `rect`, with sensible defaults for its type. */
export function createBoxShape(type: BoxShapeType, rect: Rect, ctx: NewShapeContext): Shape {
  const base = {
    id: ctx.id,
    x: rect.x,
    y: rect.y,
    w: rect.width,
    h: rect.height,
    rotation: 0,
    zIndex: ctx.zIndex,
    style: defaultStyle(type),
    groupId: null,
    createdBy: ctx.userId,
    updatedAt: ctx.now,
  };
  if (isSystemShapeType(type)) return createSystemShape(type, base);
  switch (type) {
    case "rectangle":
    case "ellipse":
      return { ...base, type, label: "" };
    case "text":
    case "sticky":
      return { ...base, type, text: "" };
  }
}

type ShapeBase = Omit<Extract<Shape, { type: "rectangle" }>, "type" | "label">;

function createSystemShape(type: SystemShapeType, base: ShapeBase): Shape {
  const label = SYSTEM_SHAPE_META[type].label;
  switch (type) {
    case "database":
      return { ...base, type, label, engine: "sql", role: "primary" };
    case "queue":
      return { ...base, type, label, mode: "queue" };
    default:
      return { ...base, type, label };
  }
}

/** Box of default size for `type`, centred on `center`. */
export function defaultRectAt(type: BoxShapeType, center: Point): Rect {
  const { w, h } = DEFAULT_SIZES[type];
  return { x: center.x - w / 2, y: center.y - h / 2, width: w, height: h };
}

export function createArrowShape(
  ends: { start: Point; end: Point; fromShapeId: string | null; toShapeId: string | null },
  ctx: NewShapeContext,
): ArrowShape {
  return {
    id: ctx.id,
    type: "arrow",
    ...arrowBoxFields(ends.start, ends.end),
    rotation: 0,
    zIndex: ctx.zIndex,
    style: defaultStyle("arrow"),
    groupId: null,
    createdBy: ctx.userId,
    updatedAt: ctx.now,
    fromShapeId: ends.fromShapeId,
    toShapeId: ends.toShapeId,
    fromAnchor: "auto",
    toAnchor: "auto",
    start: ends.start,
    end: ends.end,
    label: "",
    edgeType: "sync",
  };
}

/** Freehand shape from world-space points; stored points are relative to the bounding box. */
export function createFreehandShape(
  worldPoints: readonly number[],
  ctx: NewShapeContext,
): Shape | null {
  if (worldPoints.length < 4) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < worldPoints.length; i += 2) {
    const x = worldPoints[i] ?? 0;
    const y = worldPoints[i + 1] ?? 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return {
    id: ctx.id,
    type: "freehand",
    x: minX,
    y: minY,
    w: Math.max(1, maxX - minX),
    h: Math.max(1, maxY - minY),
    rotation: 0,
    zIndex: ctx.zIndex,
    style: defaultStyle("freehand"),
    groupId: null,
    createdBy: ctx.userId,
    updatedAt: ctx.now,
    points: worldPoints.map((v, i) => (i % 2 === 0 ? v - minX : v - minY)),
  };
}

/** Label/text content of a shape, if it has any. */
export function shapeText(shape: Shape): string | null {
  switch (shape.type) {
    case "text":
    case "sticky":
      return shape.text;
    case "freehand":
      return null;
    default:
      return shape.label;
  }
}
