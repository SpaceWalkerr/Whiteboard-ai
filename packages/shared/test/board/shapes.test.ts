import { describe, expect, it } from "vitest";
import { isSystemShapeType, shapeSchema, SYSTEM_SHAPE_TYPES } from "../../src/board";
import { arrow, database, rect, style } from "./fixtures";

describe("shapeSchema", () => {
  it("accepts every basic shape type", () => {
    const base = rect();
    const shapes = [
      base,
      { ...base, type: "ellipse" },
      { ...base, type: "text", text: "Hello", label: undefined },
      { ...base, type: "sticky", text: "Todo" },
      { ...base, type: "freehand", points: [0, 0, 10, 10] },
      arrow(),
      database(),
      { ...base, type: "queue", mode: "stream" },
    ];
    for (const shape of shapes) expect(shapeSchema.safeParse(shape).success, shape.type).toBe(true);
  });

  it.each(SYSTEM_SHAPE_TYPES.filter((t) => t !== "database" && t !== "queue"))(
    "accepts the %s system shape",
    (type) => {
      expect(shapeSchema.safeParse({ ...rect(), type }).success).toBe(true);
    },
  );

  it("rejects unknown types", () => {
    expect(shapeSchema.safeParse({ ...rect(), type: "hexagon" }).success).toBe(false);
  });

  it("requires type-specific fields", () => {
    expect(shapeSchema.safeParse({ ...rect(), type: "database" }).success).toBe(false);
    expect(shapeSchema.safeParse({ ...database(), engine: "graph" }).success).toBe(false);
    expect(shapeSchema.safeParse({ ...rect(), type: "queue", mode: "topic" }).success).toBe(false);
  });

  it("rejects non-finite geometry and negative sizes", () => {
    expect(shapeSchema.safeParse(rect({ x: Number.NaN })).success).toBe(false);
    expect(shapeSchema.safeParse(rect({ x: Number.POSITIVE_INFINITY })).success).toBe(false);
    expect(shapeSchema.safeParse(rect({ w: -1 })).success).toBe(false);
  });

  it("validates style values", () => {
    expect(shapeSchema.safeParse(rect({ style: { ...style, fill: "red" } })).success).toBe(false);
    expect(shapeSchema.safeParse(rect({ style: { ...style, fill: "transparent" } })).success).toBe(
      true,
    );
    expect(shapeSchema.safeParse(rect({ style: { ...style, opacity: 0 } })).success).toBe(false);
  });

  it("rejects freehand points that are not x,y pairs", () => {
    expect(shapeSchema.safeParse({ ...rect(), type: "freehand", points: [0, 0, 10] }).success).toBe(
      false,
    );
  });

  it("validates arrow anchors and edge types", () => {
    expect(shapeSchema.safeParse(arrow({ fromAnchor: { x: 0.5, y: 1 } })).success).toBe(true);
    expect(shapeSchema.safeParse({ ...arrow(), fromAnchor: { x: 1.5, y: 0 } }).success).toBe(false);
    expect(shapeSchema.safeParse({ ...arrow(), edgeType: "rpc" }).success).toBe(false);
  });

  it("identifies system shape types", () => {
    expect(isSystemShapeType("load_balancer")).toBe(true);
    expect(isSystemShapeType("rectangle")).toBe(false);
  });
});
