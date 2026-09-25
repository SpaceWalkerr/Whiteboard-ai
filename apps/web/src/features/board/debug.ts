import { keysAbove, SYSTEM_SHAPE_TYPES, type Shape } from "@whiteboard/shared/board";
import type { Presence, PresenceUser, SaveState, SyncStatus } from "@whiteboard/shared/sync";
import type { BoardController } from "./controller";
import { resolveArrow, type ArrowGeometry } from "./geometry/arrow";
import { createArrowShape, createBoxShape, DEFAULT_SIZES } from "./model/defaults";
import type { Viewport } from "./viewport/viewport";
import type { ViewportStore } from "./viewport/viewportStore";

/**
 * Test hooks exposed on window only in builds made with VITE_DEBUG_TOOLS=true (E2E and perf
 * runs). Production builds never set it, so this is not reachable there.
 */
export interface WhiteboardDebug {
  shapes: () => readonly Shape[];
  arrowGeometry: (id: string) => ArrowGeometry | null;
  selection: () => string[];
  tool: () => string;
  status: () => SyncStatus;
  saveState: () => SaveState;
  peers: () => Presence[];
  me: () => PresenceUser;
  viewport: () => Viewport;
  setViewport: (viewport: Viewport) => void;
  /** Adds a grid of `count` shapes (≈75% system shapes, 25% arrows connecting neighbours). */
  seed: (count: number) => number;
}

declare global {
  interface Window {
    __whiteboard?: WhiteboardDebug;
  }
}

export interface DebugExtras {
  status: () => SyncStatus;
  saveState: () => SaveState;
  peers: () => Presence[];
  me: () => PresenceUser;
}

export function installDebugTools(
  controller: BoardController,
  viewport: ViewportStore,
  extras: DebugExtras,
): () => void {
  const { store } = controller;
  window.__whiteboard = {
    ...extras,
    shapes: () => store.getSnapshot().ordered,
    arrowGeometry: (id) => {
      const shape = store.getShape(id);
      return shape?.type === "arrow" ? resolveArrow(shape, controller.lookup) : null;
    },
    selection: () => [...controller.getUi().selectedIds],
    tool: () => controller.getUi().tool,
    viewport: () => viewport.get(),
    setViewport: (vp) => {
      viewport.set(vp);
    },
    seed: (count) => {
      const boxCount = Math.ceil(count * 0.75);
      const columns = Math.ceil(Math.sqrt(boxCount * 1.6));
      const keys = keysAbove(store.getSnapshot().ordered.at(-1)?.zIndex ?? null, count);
      const shapes: Shape[] = [];
      const { w, h } = DEFAULT_SIZES.service;
      for (let i = 0; i < boxCount; i++) {
        const type = SYSTEM_SHAPE_TYPES[i % SYSTEM_SHAPE_TYPES.length] ?? "service";
        const rect = {
          x: (i % columns) * (w + 80),
          y: Math.floor(i / columns) * (h + 64),
          width: w,
          height: h,
        };
        shapes.push(
          createBoxShape(type, rect, {
            id: `seed-${i}`,
            zIndex: keys[i] ?? "a0",
            userId: "seed",
            now: 0,
          }),
        );
      }
      for (let i = 0; shapes.length < count && i < boxCount - 1; i++) {
        const from = shapes[i];
        const to = shapes[i + 1];
        if (!from || !to) break;
        shapes.push(
          createArrowShape(
            {
              start: { x: from.x, y: from.y },
              end: { x: to.x, y: to.y },
              fromShapeId: from.id,
              toShapeId: to.id,
            },
            { id: `seed-arrow-${i}`, zIndex: keys[shapes.length] ?? "a0", userId: "seed", now: 0 },
          ),
        );
      }
      store.createShapes(shapes);
      return shapes.length;
    },
  };
  return () => {
    delete window.__whiteboard;
  };
}
