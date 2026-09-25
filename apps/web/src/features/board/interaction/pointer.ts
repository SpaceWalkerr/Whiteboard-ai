import { isSystemShapeType, type Shape } from "@whiteboard/shared/board";
import type { BoardController, ToolId } from "../controller";
import {
  boxBounds,
  distance,
  rectFromPoints,
  rectsIntersect,
  unionRects,
  type Point,
  type Rect,
} from "../geometry/bounds";
import { shapeBounds } from "../geometry/shapeBounds";
import { simplifyPoints } from "../geometry/simplify";
import {
  createArrowShape,
  createBoxShape,
  createFreehandShape,
  defaultRectAt,
  type BoxShapeType,
} from "../model/defaults";
import { cullRect, panBy, type Viewport } from "../viewport/viewport";
import type { ViewportStore } from "../viewport/viewportStore";
import { snapRect, snapToGrid } from "./snapping";

export interface PointerInput {
  world: Point;
  screen: Point;
  /** Id of the shape under the pointer, if any. */
  targetId: string | null;
  shift: boolean;
  alt: boolean;
  /** Cmd on macOS, Ctrl elsewhere. Held during a drag, it disables snapping. */
  mod: boolean;
  button: number;
}

type Gesture =
  | { kind: "pan"; startScreen: Point; startViewport: Viewport }
  | {
      kind: "move";
      startWorld: Point;
      origins: Map<string, Shape>;
      candidates: Rect[];
      started: boolean;
      clickedId: string;
    }
  | { kind: "marquee"; startWorld: Point; base: ReadonlySet<string> }
  | { kind: "draw"; tool: BoxShapeType; startWorld: Point }
  | { kind: "freehand"; points: number[] }
  | { kind: "arrow"; startWorld: Point; fromId: string | null }
  | { kind: "arrowEnd"; arrowId: string; which: "start" | "end" };

/** Screen pixels a press may wander before it counts as a drag rather than a click. */
const DRAG_THRESHOLD = 3;
const SNAP_THRESHOLD = 6;
const GRID_SIZE = 20;
const MIN_DRAWN_SIZE = 8;

/**
 * Pointer gesture state machine for the canvas. Receives normalized input (world/screen
 * points, the shape under the pointer) so it has no Konva dependency and is unit-testable.
 */
export class CanvasInteractions {
  private gesture: Gesture | null = null;
  private spacePressed = false;

  constructor(
    private readonly controller: BoardController,
    private readonly viewport: ViewportStore,
  ) {}

  /** Space held = temporary hand tool. */
  setSpacePressed(pressed: boolean): void {
    this.spacePressed = pressed;
  }

  get active(): boolean {
    return this.gesture !== null;
  }

  get cursorHint(): "grabbing" | null {
    return this.gesture?.kind === "pan" ? "grabbing" : null;
  }

  down(input: PointerInput): void {
    if (input.button === 2) return;
    if (input.button === 1 || this.spacePressed) {
      this.gesture = { kind: "pan", startScreen: input.screen, startViewport: this.viewport.get() };
      return;
    }
    const { tool } = this.controller.getUi();
    const target = this.targetShape(input.targetId);

    if (tool === "select") {
      this.downSelect(input, target);
    } else if (tool === "freehand") {
      this.gesture = { kind: "freehand", points: [input.world.x, input.world.y] };
    } else if (tool === "arrow") {
      this.gesture = {
        kind: "arrow",
        startWorld: input.world,
        fromId: target && target.type !== "arrow" ? target.id : null,
      };
    } else {
      const boxTool = toBoxTool(tool);
      if (boxTool) this.gesture = { kind: "draw", tool: boxTool, startWorld: input.world };
    }
  }

  /** Called by the endpoint handles of a selected arrow. */
  beginArrowEndDrag(arrowId: string, which: "start" | "end"): void {
    this.controller.beginGesture();
    this.gesture = { kind: "arrowEnd", arrowId, which };
  }

  move(input: PointerInput): void {
    const gesture = this.gesture;
    if (!gesture) return;
    switch (gesture.kind) {
      case "pan": {
        const dx = input.screen.x - gesture.startScreen.x;
        const dy = input.screen.y - gesture.startScreen.y;
        this.viewport.set(panBy(gesture.startViewport, dx, dy));
        return;
      }
      case "move":
        this.moveSelection(gesture, input);
        return;
      case "marquee": {
        const rect = rectFromPoints(gesture.startWorld, input.world);
        this.controller.setMarquee(rect);
        const lookup = this.controller.lookup;
        const hits = this.controller.store
          .getSnapshot()
          .ordered.filter((s) => rectsIntersect(shapeBounds(s, lookup), rect))
          .map((s) => s.id);
        this.controller.select([...gesture.base, ...hits]);
        return;
      }
      case "draw": {
        const rect = this.drawnRect(gesture.startWorld, input.world, input.shift);
        const draft = createBoxShape(gesture.tool, rect, this.controller.newShapeContext("draft"));
        this.controller.setDraft(draft);
        return;
      }
      case "freehand": {
        const last = { x: gesture.points.at(-2) ?? 0, y: gesture.points.at(-1) ?? 0 };
        if (distance(last, input.world) * this.viewport.get().scale < 1) return;
        gesture.points.push(input.world.x, input.world.y);
        this.controller.setDraft(
          createFreehandShape(gesture.points, this.controller.newShapeContext("draft")),
        );
        return;
      }
      case "arrow": {
        const toId = this.bindableTarget(input.targetId, gesture.fromId);
        const draft = createArrowShape(
          {
            start: gesture.startWorld,
            end: input.world,
            fromShapeId: gesture.fromId,
            toShapeId: toId,
          },
          this.controller.newShapeContext("draft"),
        );
        this.controller.setDraft(draft, toId);
        return;
      }
      case "arrowEnd": {
        const arrow = this.controller.store.getShape(gesture.arrowId);
        if (arrow?.type !== "arrow") return;
        const other = gesture.which === "start" ? arrow.toShapeId : arrow.fromShapeId;
        const targetId = this.bindableTarget(input.targetId, other, gesture.arrowId);
        this.controller.setArrowEnd(gesture.arrowId, gesture.which, input.world, targetId);
        this.controller.setBindTarget(targetId);
        return;
      }
    }
  }

  up(input: PointerInput): void {
    const gesture = this.gesture;
    this.gesture = null;
    if (!gesture) return;
    switch (gesture.kind) {
      case "pan":
        return;
      case "move":
        if (gesture.started) {
          this.controller.endGesture();
        } else if (!input.shift) {
          // A plain click on an already-selected shape narrows the selection to it.
          this.controller.select([gesture.clickedId]);
        }
        return;
      case "marquee":
        this.controller.setMarquee(null);
        return;
      case "draw":
        this.finishDraw(gesture, input);
        return;
      case "freehand": {
        const scale = this.viewport.get().scale;
        const shape = createFreehandShape(
          simplifyPoints(gesture.points, 1.5 / scale),
          this.controller.newShapeContext(),
        );
        this.controller.setDraft(null);
        if (shape) this.controller.addShape(shape, { select: false, keepTool: true });
        return;
      }
      case "arrow": {
        const toId = this.bindableTarget(input.targetId, gesture.fromId);
        this.controller.setDraft(null);
        const tooShort = distance(gesture.startWorld, input.world) * this.viewport.get().scale < 8;
        if (tooShort && toId === null) return;
        const arrow = createArrowShape(
          {
            start: gesture.startWorld,
            end: input.world,
            fromShapeId: gesture.fromId,
            toShapeId: toId,
          },
          this.controller.newShapeContext(),
        );
        this.controller.addShape(arrow);
        return;
      }
      case "arrowEnd":
        this.controller.endGesture();
        return;
    }
  }

  /** Abandons the current gesture (Escape, lost pointer capture). */
  cancel(): void {
    const gesture = this.gesture;
    this.gesture = null;
    if (!gesture) return;
    if (gesture.kind === "move" || gesture.kind === "arrowEnd") this.controller.endGesture();
    this.controller.setDraft(null);
    this.controller.setMarquee(null);
  }

  doubleClick(input: PointerInput): void {
    const target = this.targetShape(input.targetId);
    if (target) {
      this.controller.startEditing(target.id);
      return;
    }
    if (this.controller.getUi().tool === "select") {
      const shape = createBoxShape(
        "text",
        defaultRectAt("text", input.world),
        this.controller.newShapeContext(),
      );
      this.controller.addShape(shape);
      this.controller.startEditing(shape.id);
    }
  }

  // ------------------------------------------------------------------ helpers

  private downSelect(input: PointerInput, target: Shape | undefined): void {
    const { selectedIds } = this.controller.getUi();
    if (!target) {
      this.gesture = {
        kind: "marquee",
        startWorld: input.world,
        base: input.shift ? new Set(selectedIds) : new Set(),
      };
      if (!input.shift) this.controller.clearSelection();
      return;
    }
    if (input.shift) {
      this.controller.select([target.id], "toggle");
      if (!this.controller.getUi().selectedIds.has(target.id)) return;
    } else if (!selectedIds.has(target.id)) {
      this.controller.select([target.id]);
    }

    const selected = this.controller.selectedShapes();
    const origins = new Map(selected.map((s) => [s.id, s]));
    // Snap candidates: visible shapes that are not moving.
    const vp = this.viewport.get();
    const area = cullRect(vp, this.viewport.getSize());
    const candidates = this.controller.store
      .getSnapshot()
      .ordered.filter((s) => s.type !== "arrow" && !origins.has(s.id))
      .map(boxBounds)
      .filter((b) => rectsIntersect(b, area));
    this.gesture = {
      kind: "move",
      startWorld: input.world,
      origins,
      candidates,
      started: false,
      clickedId: target.id,
    };
  }

  private moveSelection(gesture: Extract<Gesture, { kind: "move" }>, input: PointerInput): void {
    const scale = this.viewport.get().scale;
    let dx = input.world.x - gesture.startWorld.x;
    let dy = input.world.y - gesture.startWorld.y;
    if (!gesture.started) {
      if (Math.hypot(dx, dy) * scale < DRAG_THRESHOLD) return;
      gesture.started = true;
      this.controller.beginGesture();
    }

    const boxes = [...gesture.origins.values()].filter((s) => s.type !== "arrow").map(boxBounds);
    const bounds = unionRects(boxes);
    let guides: ReturnType<typeof snapRect>["guides"] = [];
    if (bounds && !input.mod) {
      const moved = { ...bounds, x: bounds.x + dx, y: bounds.y + dy };
      const snap = snapRect(moved, gesture.candidates, SNAP_THRESHOLD / scale);
      dx += snap.dx;
      dy += snap.dy;
      guides = snap.guides;
      if (this.controller.getUi().gridSnap) {
        if (snap.dx === 0) dx = snapToGrid(bounds.x + dx, GRID_SIZE) - bounds.x;
        if (snap.dy === 0) dy = snapToGrid(bounds.y + dy, GRID_SIZE) - bounds.y;
      }
    }
    this.controller.moveShapes(gesture.origins, dx, dy);
    this.controller.setGuides(guides);
  }

  private finishDraw(gesture: Extract<Gesture, { kind: "draw" }>, input: PointerInput): void {
    this.controller.setDraft(null);
    const scale = this.viewport.get().scale;
    const dragged = distance(gesture.startWorld, input.world) * scale >= DRAG_THRESHOLD;
    const rect =
      dragged && gesture.tool !== "text"
        ? this.drawnRect(gesture.startWorld, input.world, input.shift)
        : defaultRectAt(gesture.tool, gesture.startWorld);
    const shape = createBoxShape(gesture.tool, rect, this.controller.newShapeContext());
    this.controller.addShape(shape);
    if (gesture.tool === "text" || gesture.tool === "sticky")
      this.controller.startEditing(shape.id);
  }

  private drawnRect(start: Point, end: Point, square: boolean): Rect {
    let rect = rectFromPoints(start, end);
    if (square) {
      const size = Math.max(rect.width, rect.height);
      rect = {
        x: end.x < start.x ? start.x - size : start.x,
        y: end.y < start.y ? start.y - size : start.y,
        width: size,
        height: size,
      };
    }
    return {
      ...rect,
      width: Math.max(MIN_DRAWN_SIZE, rect.width),
      height: Math.max(MIN_DRAWN_SIZE, rect.height),
    };
  }

  private targetShape(id: string | null): Shape | undefined {
    return id === null ? undefined : this.controller.store.getShape(id);
  }

  /** A shape an arrow end may bind to: not an arrow, not the arrow's other end. */
  private bindableTarget(
    id: string | null,
    otherEnd: string | null,
    selfId?: string,
  ): string | null {
    const target = this.targetShape(id);
    if (!target || target.type === "arrow" || target.id === otherEnd || target.id === selfId)
      return null;
    return target.id;
  }
}

function toBoxTool(tool: ToolId): BoxShapeType | null {
  if (tool === "rectangle" || tool === "ellipse" || tool === "text" || tool === "sticky")
    return tool;
  return isSystemShapeType(tool) ? tool : null;
}
