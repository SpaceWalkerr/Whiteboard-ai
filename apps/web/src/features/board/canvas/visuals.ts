import type { EdgeType, ShapeStyle } from "@whiteboard/shared/board";

/** Visual constants shared by the Konva renderer and the SVG exporter so they match. */
export const FONT_FAMILY =
  'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
export const LINE_HEIGHT = 1.3;

/** Dash patterns as multiples of the stroke width. */
export const STROKE_DASH: Record<ShapeStyle["strokeStyle"], readonly number[]> = {
  solid: [],
  dashed: [4, 3],
  dotted: [1, 2.5],
};

export const ARROW_DASH: Record<EdgeType, readonly number[]> = {
  sync: [],
  async: [4, 3],
  replication: [1, 2.5],
};

export const SYSTEM_LAYOUT = {
  radius: 10,
  iconSize: 28,
  iconTop: 12,
  labelTop: 46,
  captionSize: 11,
  captionColor: "#4b5563",
} as const;
