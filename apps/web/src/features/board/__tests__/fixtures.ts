import { BoardHistory, BoardStore, type Shape, type ShapeOf } from "@whiteboard/shared/board";
import { BoardController } from "../controller";
import { CanvasInteractions, type PointerInput } from "../interaction/pointer";
import { createBoxShape } from "../model/defaults";
import { ViewportStore } from "../viewport/viewportStore";

export function box(
  type: Parameters<typeof createBoxShape>[0],
  rect: { x: number; y: number; width: number; height: number },
  id: string,
  /** Type-specific overrides (e.g. label, rotation); the result is a test fixture. */
  extra: Record<string, unknown> = {},
): Shape {
  return { ...createBoxShape(type, rect, { id, zIndex: "a0", userId: "test", now: 0 }), ...extra };
}

export function rect(
  id: string,
  x: number,
  y: number,
  w = 100,
  h = 50,
  extra: Partial<ShapeOf<"rectangle">> = {},
): Shape {
  return box("rectangle", { x, y, width: w, height: h }, id, extra);
}

export function setup() {
  let n = 0;
  const store = new BoardStore({ now: () => 1 });
  const history = new BoardHistory(store, { captureTimeout: 0 });
  const controller = new BoardController(store, history, {
    newId: () => `id-${++n}`,
    now: () => 1,
  });
  const viewport = new ViewportStore();
  viewport.setSize({ width: 1000, height: 800 });
  const interactions = new CanvasInteractions(controller, viewport);
  return { store, history, controller, viewport, interactions };
}

export function pointer(
  x: number,
  y: number,
  targetId: string | null = null,
  extra: Partial<PointerInput> = {},
): PointerInput {
  return {
    world: { x, y },
    screen: { x, y },
    targetId,
    shift: false,
    alt: false,
    mod: false,
    button: 0,
    ...extra,
  };
}
