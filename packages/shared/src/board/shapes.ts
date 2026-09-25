import { z } from "zod";

/**
 * Board data model. Every shape on a board is one of these, validated with zod whenever it
 * enters or leaves the Y.Doc, so malformed data (from a buggy client or, from Phase 2 on, the
 * network) can never reach the renderer or the AI review.
 *
 * Geometry follows Konva's model: (x, y) is the shape's local origin (top-left corner before
 * rotation) in world coordinates, and `rotation` is in degrees around that origin.
 */

export const shapeIdSchema = z.string().min(1).max(64);

const hexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i, { message: "must be a #rrggbb color" });

export const shapeStyleSchema = z.object({
  fill: z.union([hexColorSchema, z.literal("transparent")]),
  stroke: hexColorSchema,
  strokeWidth: z.number().min(0).max(32),
  strokeStyle: z.enum(["solid", "dashed", "dotted"]),
  fontSize: z.number().min(8).max(128),
  opacity: z.number().min(0.1).max(1),
});
export type ShapeStyle = z.infer<typeof shapeStyleSchema>;

// zod v4 numbers reject NaN and ±Infinity by default.
const finite = z.number();
const pointSchema = z.object({ x: finite, y: finite });
export type Point = z.infer<typeof pointSchema>;

const baseShapeFields = {
  id: shapeIdSchema,
  x: finite,
  y: finite,
  w: z.number().min(0).max(100_000),
  h: z.number().min(0).max(100_000),
  rotation: finite,
  /** Fractional-index key: shapes render in ascending (zIndex, id) order. Conflict-free. */
  zIndex: z.string().min(1).max(200),
  style: shapeStyleSchema,
  /** Shapes sharing a groupId are selected and moved together. Groups are one level deep. */
  groupId: shapeIdSchema.nullable(),
  createdBy: z.string().min(1).max(64),
  /** Epoch milliseconds of the last local change. */
  updatedAt: z.number().int().nonnegative(),
};

const labelSchema = z.string().max(500);
const longTextSchema = z.string().max(10_000);

export const rectangleShapeSchema = z.object({
  ...baseShapeFields,
  type: z.literal("rectangle"),
  label: labelSchema,
});
export const ellipseShapeSchema = z.object({
  ...baseShapeFields,
  type: z.literal("ellipse"),
  label: labelSchema,
});
export const textShapeSchema = z.object({
  ...baseShapeFields,
  type: z.literal("text"),
  text: longTextSchema,
});
export const stickyShapeSchema = z.object({
  ...baseShapeFields,
  type: z.literal("sticky"),
  text: longTextSchema,
});
export const freehandShapeSchema = z.object({
  ...baseShapeFields,
  type: z.literal("freehand"),
  /** Flat [x0, y0, x1, y1, ...] in the shape's local coordinates (0..w, 0..h). */
  points: z
    .array(finite)
    .min(4)
    .max(20_000)
    .refine((points) => points.length % 2 === 0, { message: "must contain x,y pairs" }),
});

/** Typed system-design components (SPEC.md §2). Order is the palette order. */
export const SYSTEM_SHAPE_TYPES = [
  "client",
  "cdn",
  "load_balancer",
  "api_gateway",
  "service",
  "database",
  "cache",
  "queue",
  "object_storage",
  "search_index",
  "worker",
  "external_api",
] as const;
export type SystemShapeType = (typeof SYSTEM_SHAPE_TYPES)[number];

function systemShape<T extends SystemShapeType>(type: T) {
  return z.object({ ...baseShapeFields, type: z.literal(type), label: labelSchema });
}

export const databaseShapeSchema = systemShape("database").extend({
  engine: z.enum(["sql", "nosql"]),
  role: z.enum(["primary", "replica"]),
});
export const queueShapeSchema = systemShape("queue").extend({
  mode: z.enum(["queue", "stream"]),
});

/** Where an arrow end attaches: "auto" picks the edge facing the other end. */
export const anchorSchema = z.union([
  z.literal("auto"),
  z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
]);
export type Anchor = z.infer<typeof anchorSchema>;

export const EDGE_TYPES = ["sync", "async", "replication"] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

/**
 * Arrows are derived from their bindings: a bound end follows its shape. `start`/`end` hold the
 * world position of an unbound end (and the last known position of a bound one). For arrows,
 * x/y/w/h are the bounds of start/end and are informational only.
 */
export const arrowShapeSchema = z.object({
  ...baseShapeFields,
  type: z.literal("arrow"),
  fromShapeId: shapeIdSchema.nullable(),
  toShapeId: shapeIdSchema.nullable(),
  fromAnchor: anchorSchema,
  toAnchor: anchorSchema,
  start: pointSchema,
  end: pointSchema,
  label: labelSchema,
  edgeType: z.enum(EDGE_TYPES),
});

export const shapeSchema = z.discriminatedUnion("type", [
  rectangleShapeSchema,
  ellipseShapeSchema,
  textShapeSchema,
  stickyShapeSchema,
  freehandShapeSchema,
  arrowShapeSchema,
  systemShape("client"),
  systemShape("cdn"),
  systemShape("load_balancer"),
  systemShape("api_gateway"),
  systemShape("service"),
  databaseShapeSchema,
  systemShape("cache"),
  queueShapeSchema,
  systemShape("object_storage"),
  systemShape("search_index"),
  systemShape("worker"),
  systemShape("external_api"),
]);

export type Shape = z.infer<typeof shapeSchema>;
export type ShapeType = Shape["type"];
export type ShapeOf<T extends ShapeType> = Extract<Shape, { type: T }>;
export type ArrowShape = ShapeOf<"arrow">;
export type SystemShape = Extract<Shape, { type: SystemShapeType }>;

const systemShapeTypes: ReadonlySet<string> = new Set(SYSTEM_SHAPE_TYPES);

export function isSystemShapeType(type: string): type is SystemShapeType {
  return systemShapeTypes.has(type);
}

export function isSystemShape(shape: Shape): shape is SystemShape {
  return isSystemShapeType(shape.type);
}

export function isArrow(shape: Shape): shape is ArrowShape {
  return shape.type === "arrow";
}

/** Fields a caller may change on an existing shape. `style` is merged key by key. */
type Patchable<S> = S extends Shape
  ? Partial<Omit<S, "id" | "type" | "style">> & { style?: Partial<ShapeStyle> }
  : never;
export type ShapePatch = Patchable<Shape>;
