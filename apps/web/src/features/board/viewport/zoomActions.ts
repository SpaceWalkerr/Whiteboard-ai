import type { BoardStore } from "@whiteboard/shared/board";
import { unionRects, type Rect } from "../geometry/bounds";
import { shapeBounds } from "../geometry/shapeBounds";
import { fitRect, zoomAt } from "./viewport";
import type { ViewportStore } from "./viewportStore";

export interface Insets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Screen space taken by the floating palette (left), properties panel (right) and bars. */
export const PANEL_INSETS: Insets = { left: 110, right: 290, top: 70, bottom: 70 };

/** Never zoom in further than this to show a few shapes: one box shouldn't fill the screen. */
const FOCUS_MAX_SCALE = 1.25;

function center(viewport: ViewportStore) {
  const size = viewport.getSize();
  return { x: size.width / 2, y: size.height / 2 };
}

export function zoomBy(viewport: ViewportStore, factor: number): void {
  const vp = viewport.get();
  viewport.set(zoomAt(vp, center(viewport), vp.scale * factor));
}

export function zoomReset(viewport: ViewportStore): void {
  viewport.set(zoomAt(viewport.get(), center(viewport), 1));
}

export function zoomToFit(store: BoardStore, viewport: ViewportStore): void {
  const { shapes, ordered } = store.getSnapshot();
  const bounds = unionRects(ordered.map((s) => shapeBounds(s, (id) => shapes.get(id))));
  if (!bounds) {
    viewport.set({ x: 0, y: 0, scale: 1 });
    return;
  }
  // Fit into the area not covered by the floating panels, then shift into place.
  const size = viewport.getSize();
  const area = {
    width: Math.max(1, size.width - PANEL_INSETS.left - PANEL_INSETS.right),
    height: Math.max(1, size.height - PANEL_INSETS.top - PANEL_INSETS.bottom),
  };
  const fitted = fitRect(bounds, area, 32);
  viewport.set({ ...fitted, x: fitted.x + PANEL_INSETS.left, y: fitted.y + PANEL_INSETS.top });
}

/**
 * Pans and zooms so the given shapes fill the area not covered by panels (`inset` screen
 * pixels on each side). Unknown ids are skipped; returns false if none of them exist.
 */
export function zoomToShapes(
  store: BoardStore,
  viewport: ViewportStore,
  ids: readonly string[],
  inset: Insets = PANEL_INSETS,
): boolean {
  const { shapes } = store.getSnapshot();
  const lookup = (id: string) => shapes.get(id);
  const bounds = unionRects(
    ids.flatMap((id) => {
      const shape = shapes.get(id);
      return shape ? [shapeBounds(shape, lookup)] : [];
    }),
  );
  if (!bounds) return false;
  const size = viewport.getSize();
  const area = {
    width: Math.max(1, size.width - inset.left - inset.right),
    height: Math.max(1, size.height - inset.top - inset.bottom),
  };
  const fitted = fitRect(bounds, area, 48, FOCUS_MAX_SCALE);
  viewport.set({ ...fitted, x: fitted.x + inset.left, y: fitted.y + inset.top });
  return true;
}

/**
 * Pans (without zooming) so `rect` is fully visible, keeping clear of the floating panels
 * (`inset` screen pixels on each side). Does nothing if it is already visible.
 */
export function ensureVisible(viewport: ViewportStore, rect: Rect, inset = PANEL_INSETS): void {
  const vp = viewport.get();
  const size = viewport.getSize();
  const left = rect.x * vp.scale + vp.x;
  const right = (rect.x + rect.width) * vp.scale + vp.x;
  const top = rect.y * vp.scale + vp.y;
  const bottom = (rect.y + rect.height) * vp.scale + vp.y;
  let dx = 0;
  let dy = 0;
  if (right > size.width - inset.right) dx = size.width - inset.right - right;
  if (left + dx < inset.left) dx = inset.left - left;
  if (bottom > size.height - inset.bottom) dy = size.height - inset.bottom - bottom;
  if (top + dy < inset.top) dy = inset.top - top;
  if (dx !== 0 || dy !== 0) viewport.set({ ...vp, x: vp.x + dx, y: vp.y + dy });
}

/** World point at the centre of the screen (where keyboard-inserted shapes go). */
export function viewportCenterWorld(viewport: ViewportStore): { x: number; y: number } {
  const vp = viewport.get();
  const c = center(viewport);
  return { x: (c.x - vp.x) / vp.scale, y: (c.y - vp.y) / vp.scale };
}
