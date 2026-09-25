import type { Shape, ShapeOf, ShapeStyle } from "../../src/board";

export const style: ShapeStyle = {
  fill: "#ffffff",
  stroke: "#1f2937",
  strokeWidth: 2,
  strokeStyle: "solid",
  fontSize: 16,
  opacity: 1,
};

let counter = 0;

export function rect(overrides: Partial<ShapeOf<"rectangle">> = {}): ShapeOf<"rectangle"> {
  counter += 1;
  return {
    id: `rect-${counter}`,
    type: "rectangle",
    x: 0,
    y: 0,
    w: 100,
    h: 50,
    rotation: 0,
    zIndex: `a${counter}`,
    style,
    groupId: null,
    createdBy: "local",
    updatedAt: 0,
    label: "",
    ...overrides,
  };
}

export function database(overrides: Partial<ShapeOf<"database">> = {}): ShapeOf<"database"> {
  counter += 1;
  return {
    id: `db-${counter}`,
    type: "database",
    x: 0,
    y: 0,
    w: 160,
    h: 96,
    rotation: 0,
    zIndex: `a${counter}`,
    style,
    groupId: null,
    createdBy: "local",
    updatedAt: 0,
    label: "Orders DB",
    engine: "sql",
    role: "primary",
    ...overrides,
  };
}

export function arrow(overrides: Partial<ShapeOf<"arrow">> = {}): ShapeOf<"arrow"> {
  counter += 1;
  return {
    id: `arrow-${counter}`,
    type: "arrow",
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    rotation: 0,
    zIndex: `a${counter}`,
    style,
    groupId: null,
    createdBy: "local",
    updatedAt: 0,
    fromShapeId: null,
    toShapeId: null,
    fromAnchor: "auto",
    toAnchor: "auto",
    start: { x: 0, y: 0 },
    end: { x: 100, y: 0 },
    label: "",
    edgeType: "sync",
    ...overrides,
  };
}

export function ids(shapes: readonly Shape[]): string[] {
  return shapes.map((s) => s.id);
}
