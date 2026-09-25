import {
  cloneShapes,
  keysAbove,
  parseClipboard,
  serializeClipboard,
  type BoardHistory,
  type BoardStore,
  type ReorderMode,
  type Shape,
  type ShapePatch,
  type ShapeStyle,
  type SystemShapeType,
} from "@whiteboard/shared/board";
import { arrowBoxFields, resolveArrow, type ShapeLookup } from "./geometry/arrow";
import { boxBounds, rectsIntersect, unionRects, type Point, type Rect } from "./geometry/bounds";
import { shapeBounds } from "./geometry/shapeBounds";
import {
  alignDeltas,
  distributeDeltas,
  type AlignMode,
  type AlignUnit,
  type Delta,
  type DistributeAxis,
} from "./interaction/align";
import type { Guide } from "./interaction/snapping";
import {
  createArrowShape,
  createBoxShape,
  defaultRectAt,
  DEFAULT_SIZES,
  shapeText,
  type NewShapeContext,
} from "./model/defaults";

export type DrawingTool = "rectangle" | "ellipse" | "text" | "sticky" | "freehand" | "arrow";
export type ToolId = "select" | DrawingTool | SystemShapeType;

export interface BoardUiState {
  tool: ToolId;
  selectedIds: ReadonlySet<string>;
  /** Shape whose text/label is being edited in the HTML overlay. */
  editingId: string | null;
  guides: readonly Guide[];
  marquee: Rect | null;
  /** Shape being drawn; rendered in the overlay, not yet in the doc. */
  draft: Shape | null;
  /** Shape an arrow end will bind to if released now. */
  bindTargetId: string | null;
  gridSnap: boolean;
}

export type SelectMode = "replace" | "add" | "toggle";

export interface BoardControllerOptions {
  newId?: () => string;
  now?: () => number;
}

const PASTE_OFFSET = 24;
const INSERT_GAP = 80;

/**
 * All board editing commands. Owns UI state (tool, selection, drafts) and writes shapes only
 * through BoardStore. No Konva or DOM here, so every command is unit-testable.
 */
export class BoardController {
  private ui: BoardUiState = {
    tool: "select",
    selectedIds: new Set(),
    editingId: null,
    guides: [],
    marquee: null,
    draft: null,
    bindTargetId: null,
    gridSnap: false,
  };
  private readonly listeners = new Set<() => void>();
  private readonly newId: () => string;
  private readonly now: () => number;
  private readonly unsubscribeStore: () => void;

  constructor(
    readonly store: BoardStore,
    readonly history: BoardHistory,
    options: BoardControllerOptions = {},
  ) {
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.now = options.now ?? Date.now;
    // Undo, redo or (later) a collaborator can delete selected shapes; drop them from selection.
    this.unsubscribeStore = store.subscribe(() => {
      this.pruneSelection();
    });
  }

  readonly lookup: ShapeLookup = (id) => this.store.getShape(id);

  getUi = (): BoardUiState => this.ui;

  subscribeUi = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  destroy(): void {
    this.unsubscribeStore();
    this.listeners.clear();
  }

  // ---------------------------------------------------------------- UI state

  setTool(tool: ToolId): void {
    this.setUi({ tool, draft: null, bindTargetId: null, editingId: null });
  }

  setGuides(guides: readonly Guide[]): void {
    if (guides.length === 0 && this.ui.guides.length === 0) return;
    this.setUi({ guides });
  }

  setMarquee(marquee: Rect | null): void {
    this.setUi({ marquee });
  }

  setDraft(draft: Shape | null, bindTargetId: string | null = null): void {
    this.setUi({ draft, bindTargetId });
  }

  setBindTarget(bindTargetId: string | null): void {
    if (bindTargetId !== this.ui.bindTargetId) this.setUi({ bindTargetId });
  }

  toggleGridSnap(): void {
    this.setUi({ gridSnap: !this.ui.gridSnap });
  }

  // ---------------------------------------------------------------- selection

  select(ids: Iterable<string>, mode: SelectMode = "replace"): void {
    const expanded = this.expandGroups(ids);
    let next: Set<string>;
    if (mode === "replace") {
      next = expanded;
    } else if (mode === "add") {
      next = new Set([...this.ui.selectedIds, ...expanded]);
    } else {
      next = new Set(this.ui.selectedIds);
      const allSelected = [...expanded].every((id) => next.has(id));
      for (const id of expanded) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
    }
    if (setsEqual(next, this.ui.selectedIds)) return;
    this.setUi({ selectedIds: next });
  }

  clearSelection(): void {
    if (this.ui.selectedIds.size > 0) this.setUi({ selectedIds: new Set() });
  }

  selectAll(): void {
    this.select(this.store.getSnapshot().ordered.map((s) => s.id));
  }

  /** Selected shapes in render order. */
  selectedShapes(): Shape[] {
    return this.store.getSnapshot().ordered.filter((s) => this.ui.selectedIds.has(s.id));
  }

  /** Tab / Shift+Tab: cycle through shapes (not arrows) so the board is keyboard-navigable. */
  selectAdjacent(direction: 1 | -1): void {
    const shapes = this.store.getSnapshot().ordered.filter((s) => s.type !== "arrow");
    if (shapes.length === 0) return;
    const indexes = shapes.flatMap((s, i) => (this.ui.selectedIds.has(s.id) ? [i] : []));
    const current = direction === 1 ? (indexes.at(-1) ?? -1) : (indexes[0] ?? shapes.length);
    const next = shapes[(current + direction + shapes.length) % shapes.length];
    if (next) this.select([next.id]);
  }

  // ---------------------------------------------------------------- creation

  newShapeContext(id = this.newId()): NewShapeContext {
    return { id, zIndex: this.store.nextZIndex(), userId: this.store.userId, now: this.now() };
  }

  /** Adds a finished shape (from a drawing tool) and selects it. */
  addShape(shape: Shape, options: { select?: boolean; keepTool?: boolean } = {}): void {
    this.command(() => {
      this.store.createShape({ ...shape, zIndex: this.store.nextZIndex() });
    });
    this.setUi({
      draft: null,
      bindTargetId: null,
      tool: options.keepTool ? this.ui.tool : "select",
      selectedIds: options.select === false ? this.ui.selectedIds : new Set([shape.id]),
    });
  }

  /**
   * Keyboard-first insertion ("/" palette). With a shape to connect from, the new shape goes to
   * its right (moving down past anything in the way) and an arrow links them.
   */
  insertSystemShape(type: SystemShapeType, center: Point, connectFromId: string | null): string {
    const from = connectFromId ? this.store.getShape(connectFromId) : undefined;
    let rect = defaultRectAt(type, center);
    if (from && from.type !== "arrow") {
      const b = boxBounds(from);
      const { w, h } = DEFAULT_SIZES[type];
      rect = { x: b.x + b.width + INSERT_GAP, y: b.y + b.height / 2 - h / 2, width: w, height: h };
      const obstacles = this.store
        .getSnapshot()
        .ordered.filter((s) => s.type !== "arrow")
        .map(boxBounds);
      while (obstacles.some((o) => rectsIntersect(o, rect))) rect = { ...rect, y: rect.y + h + 40 };
    }

    const shape = createBoxShape(type, rect, this.newShapeContext());
    this.command(() => {
      this.store.createShape(shape);
      if (from && from.type !== "arrow") {
        const arrow = createArrowShape(
          {
            start: { x: rect.x, y: rect.y },
            end: { x: rect.x, y: rect.y },
            fromShapeId: from.id,
            toShapeId: shape.id,
          },
          this.newShapeContext(),
        );
        this.store.createShape(arrow);
      }
    });
    this.setUi({ selectedIds: new Set([shape.id]), tool: "select" });
    return shape.id;
  }

  // ---------------------------------------------------------------- gestures

  /** Everything between begin and end (a drag, a resize) undoes as one step. */
  beginGesture(): void {
    this.history.beginStep();
  }

  endGesture(): void {
    this.history.endStep();
    this.setUi({ guides: [], marquee: null, bindTargetId: null });
  }

  /** Moves shapes to their original positions + delta (origins captured at gesture start). */
  moveShapes(origins: ReadonlyMap<string, Shape>, dx: number, dy: number): void {
    const updates: { id: string; patch: ShapePatch }[] = [];
    for (const [id, origin] of origins) {
      if (origin.type === "arrow") {
        const start = { x: origin.start.x + dx, y: origin.start.y + dy };
        const end = { x: origin.end.x + dx, y: origin.end.y + dy };
        updates.push({ id, patch: { start, end, ...arrowBoxFields(start, end) } });
      } else {
        updates.push({ id, patch: { x: origin.x + dx, y: origin.y + dy } });
      }
    }
    this.store.updateShapes(updates);
  }

  /** Applies resize/rotate results from the transformer. Freehand points scale with the box. */
  applyTransforms(
    transforms: readonly {
      id: string;
      x: number;
      y: number;
      w: number;
      h: number;
      rotation: number;
    }[],
  ): void {
    const updates = transforms.flatMap(({ id, x, y, w, h, rotation }) => {
      const shape = this.store.getShape(id);
      if (!shape || shape.type === "arrow") return [];
      const size = { w: Math.max(1, w), h: Math.max(1, h) };
      if (shape.type === "freehand") {
        const sx = size.w / Math.max(1, shape.w);
        const sy = size.h / Math.max(1, shape.h);
        const points = shape.points.map((v, i) => (i % 2 === 0 ? v * sx : v * sy));
        return [{ id, patch: { x, y, rotation, ...size, points } }];
      }
      return [{ id, patch: { x, y, rotation, ...size } }];
    });
    if (updates.length > 0) this.store.updateShapes(updates);
  }

  /** Moves one end of an arrow and (re)binds it to `targetId` or leaves it free. */
  setArrowEnd(
    arrowId: string,
    which: "start" | "end",
    point: Point,
    targetId: string | null,
  ): void {
    const arrow = this.store.getShape(arrowId);
    if (arrow?.type !== "arrow") return;
    const otherBound = which === "start" ? arrow.toShapeId : arrow.fromShapeId;
    const binding = targetId !== null && targetId !== otherBound ? targetId : null;
    const start = which === "start" ? point : arrow.start;
    const end = which === "end" ? point : arrow.end;
    this.store.updateShape(arrowId, {
      start,
      end,
      ...arrowBoxFields(start, end),
      ...(which === "start"
        ? { fromShapeId: binding, fromAnchor: "auto" as const }
        : { toShapeId: binding, toAnchor: "auto" as const }),
    });
  }

  // ---------------------------------------------------------------- editing commands

  deleteSelection(): void {
    if (this.ui.selectedIds.size === 0) return;
    const ids = [...this.ui.selectedIds];
    this.command(() => {
      this.store.deleteShapes(ids);
    });
    this.setUi({ selectedIds: new Set(), editingId: null });
  }

  duplicateSelection(): void {
    const selected = this.selectedShapes();
    if (selected.length === 0) return;
    this.insertClones(this.freezeArrows(selected), { x: PASTE_OFFSET, y: PASTE_OFFSET });
  }

  /** Clipboard text for the selection, or null if nothing is selected. */
  copySelection(): string | null {
    const selected = this.selectedShapes();
    return selected.length === 0 ? null : serializeClipboard(this.freezeArrows(selected));
  }

  cutSelection(): string | null {
    const text = this.copySelection();
    if (text !== null) this.deleteSelection();
    return text;
  }

  /**
   * Pastes our clipboard format (centred on `at` when given), or turns plain text into a text
   * shape. Returns false if there was nothing usable.
   */
  paste(text: string, at: Point | null): boolean {
    const shapes = parseClipboard(text);
    if (shapes) {
      const lookup: ShapeLookup = (id) => shapes.find((s) => s.id === id);
      const bounds = unionRects(shapes.map((s) => shapeBounds(s, lookup)));
      const offset =
        at && bounds
          ? { x: at.x - (bounds.x + bounds.width / 2), y: at.y - (bounds.y + bounds.height / 2) }
          : { x: PASTE_OFFSET, y: PASTE_OFFSET };
      this.insertClones(shapes, offset);
      return true;
    }
    const plain = text.trim();
    if (plain === "" || !at) return false;
    const shape = createBoxShape("text", defaultRectAt("text", at), this.newShapeContext());
    this.addShape({ ...shape, text: plain.slice(0, 10_000) } as Shape);
    return true;
  }

  groupSelection(): void {
    const selected = this.selectedShapes();
    if (selected.length < 2) return;
    const groupId = this.newId();
    this.command(() => {
      this.store.updateShapes(selected.map((s) => ({ id: s.id, patch: { groupId } })));
    });
  }

  ungroupSelection(): void {
    const grouped = this.selectedShapes().filter((s) => s.groupId !== null);
    if (grouped.length === 0) return;
    this.command(() => {
      this.store.updateShapes(grouped.map((s) => ({ id: s.id, patch: { groupId: null } })));
    });
  }

  alignSelection(mode: AlignMode): void {
    this.applyUnitDeltas((units) => alignDeltas(units, mode));
  }

  distributeSelection(axis: DistributeAxis): void {
    this.applyUnitDeltas((units) => distributeDeltas(units, axis));
  }

  reorderSelection(mode: ReorderMode): void {
    if (this.ui.selectedIds.size === 0) return;
    const ids = [...this.ui.selectedIds];
    this.command(() => {
      this.store.reorder(ids, mode);
    });
  }

  /** Arrow-key nudges. Not wrapped in a command, so rapid nudges merge into one undo step. */
  nudgeSelection(dx: number, dy: number): void {
    const selected = this.selectedShapes();
    if (selected.length === 0) return;
    this.moveShapes(new Map(selected.map((s) => [s.id, s])), dx, dy);
  }

  updateSelectionStyle(style: Partial<ShapeStyle>): void {
    const selected = this.selectedShapes();
    if (selected.length === 0) return;
    this.command(() => {
      this.store.updateShapes(selected.map((s) => ({ id: s.id, patch: { style } })));
    });
  }

  updateShape(id: string, patch: ShapePatch): void {
    this.command(() => {
      this.store.updateShape(id, patch);
    });
  }

  startEditing(id: string): void {
    const shape = this.store.getShape(id);
    if (!shape || shapeText(shape) === null) return;
    this.setUi({ editingId: id, selectedIds: new Set([id]), tool: "select" });
  }

  stopEditing(): void {
    if (this.ui.editingId !== null) this.setUi({ editingId: null });
  }

  /** Saves edited text. An emptied text shape is removed, as in most whiteboards. */
  commitText(id: string, value: string, measuredHeight: number | null): void {
    const shape = this.store.getShape(id);
    this.stopEditing();
    if (!shape) return;
    const text = value.slice(0, shape.type === "text" || shape.type === "sticky" ? 10_000 : 500);
    this.command(() => {
      if (shape.type === "text") {
        if (text.trim() === "") {
          this.store.deleteShapes([id]);
          return;
        }
        this.store.updateShape(id, {
          text,
          ...(measuredHeight !== null ? { h: Math.max(measuredHeight, 1) } : {}),
        });
      } else if (shape.type === "sticky") {
        this.store.updateShape(id, { text });
      } else if (shape.type !== "freehand") {
        this.store.updateShape(id, { label: text });
      }
    });
  }

  undo(): void {
    this.history.undo();
  }

  redo(): void {
    this.history.redo();
  }

  // ---------------------------------------------------------------- internals

  /** One undo step per user command, never merged with the previous or next action. */
  private command(fn: () => void): void {
    this.history.runAsSingleStep(() => {
      this.store.transact(fn);
    });
  }

  private insertClones(shapes: readonly Shape[], offset: Point): void {
    const top = this.store.getSnapshot().ordered.at(-1)?.zIndex ?? null;
    const clones = cloneShapes(shapes, {
      offset,
      zIndexKeys: keysAbove(top, shapes.length),
      userId: this.store.userId,
      now: this.now(),
      newId: this.newId,
    });
    this.command(() => {
      this.store.createShapes(clones);
    });
    this.setUi({ selectedIds: new Set(clones.map((c) => c.id)) });
  }

  /** Copies of arrows whose stored start/end match where they are drawn right now. */
  private freezeArrows(shapes: readonly Shape[]): Shape[] {
    return shapes.map((shape) => {
      if (shape.type !== "arrow") return shape;
      const { start, end } = resolveArrow(shape, this.lookup);
      return { ...shape, start, end, ...arrowBoxFields(start, end) };
    });
  }

  private applyUnitDeltas(compute: (units: AlignUnit[]) => Map<string, Delta>): void {
    const members = new Map<string, Shape[]>();
    for (const shape of this.selectedShapes()) {
      if (shape.type === "arrow") continue;
      const key = shape.groupId ?? shape.id;
      members.set(key, [...(members.get(key) ?? []), shape]);
    }
    const units = [...members].flatMap(([key, shapes]) => {
      const bounds = unionRects(shapes.map(boxBounds));
      return bounds ? [{ key, bounds }] : [];
    });
    const deltas = compute(units);
    if (deltas.size === 0) return;
    this.command(() => {
      for (const [key, { dx, dy }] of deltas) {
        const shapes = members.get(key) ?? [];
        this.moveShapes(new Map(shapes.map((s) => [s.id, s])), dx, dy);
      }
    });
  }

  private expandGroups(ids: Iterable<string>): Set<string> {
    const result = new Set<string>();
    const groups = new Set<string>();
    for (const id of ids) {
      const shape = this.store.getShape(id);
      if (!shape) continue;
      result.add(id);
      if (shape.groupId !== null) groups.add(shape.groupId);
    }
    if (groups.size > 0) {
      for (const shape of this.store.getSnapshot().ordered) {
        if (shape.groupId !== null && groups.has(shape.groupId)) result.add(shape.id);
      }
    }
    return result;
  }

  private pruneSelection(): void {
    const { selectedIds, editingId } = this.ui;
    const kept = [...selectedIds].filter((id) => this.store.getShape(id));
    const editingGone = editingId !== null && !this.store.getShape(editingId);
    if (kept.length !== selectedIds.size || editingGone) {
      this.setUi({ selectedIds: new Set(kept), editingId: editingGone ? null : editingId });
    }
  }

  private setUi(patch: Partial<BoardUiState>): void {
    this.ui = { ...this.ui, ...patch };
    for (const listener of this.listeners) listener();
  }
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}
