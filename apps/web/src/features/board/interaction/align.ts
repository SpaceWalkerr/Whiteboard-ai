import type { Rect } from "../geometry/bounds";

export type AlignMode = "left" | "center" | "right" | "top" | "middle" | "bottom";
export type DistributeAxis = "horizontal" | "vertical";

/** A unit that moves as one: a single shape, or a whole group. */
export interface AlignUnit {
  key: string;
  bounds: Rect;
}

export interface Delta {
  dx: number;
  dy: number;
}

/** Aligns units to the combined bounds of all of them (like Figma and Keynote). */
export function alignDeltas(units: readonly AlignUnit[], mode: AlignMode): Map<string, Delta> {
  const deltas = new Map<string, Delta>();
  if (units.length < 2) return deltas;
  const left = Math.min(...units.map((u) => u.bounds.x));
  const right = Math.max(...units.map((u) => u.bounds.x + u.bounds.width));
  const top = Math.min(...units.map((u) => u.bounds.y));
  const bottom = Math.max(...units.map((u) => u.bounds.y + u.bounds.height));

  for (const { key, bounds: b } of units) {
    let dx = 0;
    let dy = 0;
    switch (mode) {
      case "left":
        dx = left - b.x;
        break;
      case "center":
        dx = (left + right) / 2 - (b.x + b.width / 2);
        break;
      case "right":
        dx = right - (b.x + b.width);
        break;
      case "top":
        dy = top - b.y;
        break;
      case "middle":
        dy = (top + bottom) / 2 - (b.y + b.height / 2);
        break;
      case "bottom":
        dy = bottom - (b.y + b.height);
        break;
    }
    if (dx !== 0 || dy !== 0) deltas.set(key, { dx, dy });
  }
  return deltas;
}

/** Spaces units so the gaps between neighbours are equal; the outermost two stay put. */
export function distributeDeltas(
  units: readonly AlignUnit[],
  axis: DistributeAxis,
): Map<string, Delta> {
  const deltas = new Map<string, Delta>();
  if (units.length < 3) return deltas;
  const horizontal = axis === "horizontal";
  const start = (r: Rect) => (horizontal ? r.x : r.y);
  const size = (r: Rect) => (horizontal ? r.width : r.height);

  const sorted = [...units].sort((a, b) => start(a.bounds) - start(b.bounds));
  const first = sorted[0];
  const last = sorted.at(-1);
  if (!first || !last) return deltas;
  const span = start(last.bounds) + size(last.bounds) - start(first.bounds);
  const occupied = sorted.reduce((sum, u) => sum + size(u.bounds), 0);
  const gap = (span - occupied) / (sorted.length - 1);

  let cursor = start(first.bounds) + size(first.bounds) + gap;
  for (const unit of sorted.slice(1, -1)) {
    const d = cursor - start(unit.bounds);
    if (d !== 0) deltas.set(unit.key, horizontal ? { dx: d, dy: 0 } : { dx: 0, dy: d });
    cursor += size(unit.bounds) + gap;
  }
  return deltas;
}
