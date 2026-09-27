import {
  shapeSchema,
  type EdgeType,
  type Shape,
  type ShapeStyle,
  type SystemShapeType,
} from "../board/shapes";
import { keysAbove } from "../board/zorder";

/**
 * Templates are written as a small grid of components plus the calls between them, and turned
 * into ordinary board shapes here. The server writes these shapes into a new board's Y.Doc and
 * the website draws its previews from the same shapes, so the two can't disagree.
 */

export interface TemplateNode {
  id: string;
  type: SystemShapeType;
  label: string;
  /** Grid position: columns are 300 px apart, rows 170 px. */
  col: number;
  row: number;
  engine?: "sql" | "nosql";
  role?: "primary" | "replica";
  mode?: "queue" | "stream";
}

export interface TemplateEdge {
  from: string;
  to: string;
  label?: string;
  type?: EdgeType;
}

const COL = 300;
const ROW = 170;
const NODE_W = 160;
const NODE_H = 96;

// Same look as a shape drawn with the toolbar (apps/web model/defaults.ts).
const NODE_STYLE: ShapeStyle = {
  fill: "#ffffff",
  stroke: "#1f2937",
  strokeWidth: 2,
  strokeStyle: "solid",
  fontSize: 16,
  opacity: 1,
};
const ARROW_STYLE: ShapeStyle = { ...NODE_STYLE, fill: "transparent", fontSize: 14 };

/** Who "created" template shapes; the board's owner is recorded on the board itself. */
export const TEMPLATE_AUTHOR = "template";

export function buildTemplateShapes(
  nodes: readonly TemplateNode[],
  edges: readonly TemplateEdge[],
): Shape[] {
  const keys = keysAbove(null, nodes.length + edges.length);
  const key = (i: number) => {
    const value = keys[i];
    if (value === undefined) throw new Error("not enough z-order keys");
    return value;
  };
  const centers = new Map<string, { x: number; y: number }>();

  const shapes: Shape[] = nodes.map((node, i) => {
    const x = node.col * COL;
    const y = node.row * ROW;
    centers.set(node.id, { x: x + NODE_W / 2, y: y + NODE_H / 2 });
    const base = {
      id: node.id,
      x,
      y,
      w: NODE_W,
      h: NODE_H,
      rotation: 0,
      zIndex: key(i),
      style: NODE_STYLE,
      groupId: null,
      createdBy: TEMPLATE_AUTHOR,
      updatedAt: 0,
      label: node.label,
    };
    switch (node.type) {
      case "database":
        return {
          ...base,
          type: node.type,
          engine: node.engine ?? "sql",
          role: node.role ?? "primary",
        };
      case "queue":
        return { ...base, type: node.type, mode: node.mode ?? "queue" };
      default:
        return { ...base, type: node.type };
    }
  });

  edges.forEach((edge, i) => {
    const start = centers.get(edge.from);
    const end = centers.get(edge.to);
    if (!start || !end) throw new Error(`Template arrow ${edge.from} → ${edge.to}: unknown shape`);
    shapes.push({
      id: `${edge.from}--${edge.to}`,
      type: "arrow",
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      w: Math.abs(end.x - start.x),
      h: Math.abs(end.y - start.y),
      rotation: 0,
      zIndex: key(nodes.length + i),
      style: ARROW_STYLE,
      groupId: null,
      createdBy: TEMPLATE_AUTHOR,
      updatedAt: 0,
      fromShapeId: edge.from,
      toShapeId: edge.to,
      fromAnchor: "auto",
      toAnchor: "auto",
      start,
      end,
      label: edge.label ?? "",
      edgeType: edge.type ?? "sync",
    });
  });

  // A typo in a template must fail loudly at startup/build, never produce a broken board.
  return shapes.map((shape) => shapeSchema.parse(shape));
}

export interface TemplateFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The area a template preview shows: every component plus a margin. Arrows run between
 * component centres, so they are inside it too. Pages use it for the image's width/height
 * (no layout shift) and the build draws the SVG with exactly this frame.
 */
export function templateFrame(shapes: readonly Shape[], margin = 48): TemplateFrame {
  const boxes = shapes.filter((shape) => shape.type !== "arrow");
  if (boxes.length === 0) return { x: 0, y: 0, width: margin * 2, height: margin * 2 };
  const minX = Math.min(...boxes.map((s) => s.x));
  const minY = Math.min(...boxes.map((s) => s.y));
  const maxX = Math.max(...boxes.map((s) => s.x + s.w));
  const maxY = Math.max(...boxes.map((s) => s.y + s.h));
  return {
    x: minX - margin,
    y: minY - margin,
    width: maxX - minX + margin * 2,
    height: maxY - minY + margin * 2,
  };
}
