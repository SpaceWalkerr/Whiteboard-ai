import type { Rect } from "../geometry/bounds";

export interface Guide {
  orientation: "vertical" | "horizontal";
  /** x for vertical guides, y for horizontal ones (world units). */
  position: number;
  from: number;
  to: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
}

function xLines(r: Rect): number[] {
  return [r.x, r.x + r.width / 2, r.x + r.width];
}

function yLines(r: Rect): number[] {
  return [r.y, r.y + r.height / 2, r.y + r.height];
}

function bestOffset(moving: number[], candidates: number[][], threshold: number): number | null {
  let best: number | null = null;
  for (const lines of candidates) {
    for (const target of lines) {
      for (const line of moving) {
        const diff = target - line;
        if (Math.abs(diff) <= threshold && (best === null || Math.abs(diff) < Math.abs(best)))
          best = diff;
      }
    }
  }
  return best;
}

/**
 * Snaps a moving rect's edges and centre to other shapes' edges and centres, and returns the
 * smart guides to draw for every alignment the snapped position produces.
 */
export function snapRect(moving: Rect, candidates: readonly Rect[], threshold: number): SnapResult {
  const dx = bestOffset(xLines(moving), candidates.map(xLines), threshold) ?? 0;
  const dy = bestOffset(yLines(moving), candidates.map(yLines), threshold) ?? 0;
  const snapped = { ...moving, x: moving.x + dx, y: moving.y + dy };

  const guides: Guide[] = [];
  const epsilon = 0.01;
  for (const line of xLines(snapped)) {
    const matches = candidates.filter((c) => xLines(c).some((l) => Math.abs(l - line) < epsilon));
    if (matches.length > 0) {
      const ys = [snapped, ...matches].flatMap((r) => [r.y, r.y + r.height]);
      guides.push({
        orientation: "vertical",
        position: line,
        from: Math.min(...ys),
        to: Math.max(...ys),
      });
    }
  }
  for (const line of yLines(snapped)) {
    const matches = candidates.filter((c) => yLines(c).some((l) => Math.abs(l - line) < epsilon));
    if (matches.length > 0) {
      const xs = [snapped, ...matches].flatMap((r) => [r.x, r.x + r.width]);
      guides.push({
        orientation: "horizontal",
        position: line,
        from: Math.min(...xs),
        to: Math.max(...xs),
      });
    }
  }
  return { dx, dy, guides };
}

export function snapToGrid(value: number, grid: number): number {
  return Math.round(value / grid) * grid;
}
