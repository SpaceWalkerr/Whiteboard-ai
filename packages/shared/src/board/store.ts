import * as Y from "yjs";
import { BoardReadOnlyError, BoardValidationError } from "./errors";
import { shapeSchema, type Shape, type ShapePatch, type ShapeStyle } from "./shapes";
import { compareOrder, keyAbove, reorderKeys, type ReorderMode } from "./zorder";

/**
 * Y.Doc layout (stable contract for the sync server and persistence in later phases):
 *   doc.getMap("shapes")  Y.Map<shapeId, Y.Map<field, value>>; `style` is a nested Y.Map so
 *                          concurrent edits to different style keys merge.
 *   doc.getMap("meta")    board metadata (schemaVersion).
 * UI code never touches Yjs directly; it goes through BoardStore.
 */
export const BOARD_SCHEMA_VERSION = 1;

export interface BoardSnapshot {
  readonly shapes: ReadonlyMap<string, Shape>;
  /** Render order, bottom to top. */
  readonly ordered: readonly Shape[];
}

export interface BoardStoreOptions {
  doc?: Y.Doc;
  /** Written to `createdBy` on new shapes. "local" until authentication exists (Phase 4). */
  userId?: string;
  /** Clock injection for tests. */
  now?: () => number;
  /** Called when a shape in the doc fails validation; the shape is left out of snapshots. */
  onInvalidShape?: (id: string, error: BoardValidationError) => void;
}

type YShape = Y.Map<unknown>;

export class BoardStore {
  readonly doc: Y.Doc;
  /** Transaction origin for every local change; undo only tracks this origin. */
  readonly localOrigin: object = { source: "local" };
  readonly userId: string;

  private readonly yShapes: Y.Map<YShape>;
  private readonly now: () => number;
  private readonly onInvalidShape: BoardStoreOptions["onInvalidShape"];
  private readonly listeners = new Set<() => void>();
  private shapes = new Map<string, Shape>();
  private snapshot: BoardSnapshot;

  constructor(options: BoardStoreOptions = {}) {
    this.doc = options.doc ?? new Y.Doc();
    this.userId = options.userId ?? "local";
    this.now = options.now ?? Date.now;
    this.onInvalidShape = options.onInvalidShape;
    this.yShapes = this.doc.getMap<YShape>("shapes");

    for (const id of this.yShapes.keys()) this.readShape(id);
    this.snapshot = this.buildSnapshot();
    this.yShapes.observeDeep(this.handleChanges);

    const meta = this.doc.getMap("meta");
    if (!meta.has("schemaVersion")) {
      this.doc.transact(() => {
        meta.set("schemaVersion", BOARD_SCHEMA_VERSION);
      }, this.localOrigin);
    }
  }

  /** @internal Used by BoardHistory; not for UI code. */
  get yShapesMap(): Y.Map<YShape> {
    return this.yShapes;
  }

  getSnapshot = (): BoardSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Committed state: changes inside an open `transact` show up once it completes. */
  getShape(id: string): Shape | undefined {
    return this.shapes.get(id);
  }

  /**
   * View-only mode (viewers). Local writes throw; remote changes still arrive. The server drops
   * a viewer's writes anyway — this keeps their local copy from ever diverging from it.
   */
  readOnly = false;

  /** Runs several changes as one Yjs transaction (one update, one undo step). */
  transact(fn: () => void): void {
    this.assertWritable();
    this.doc.transact(fn, this.localOrigin);
  }

  private assertWritable(): void {
    if (this.readOnly) throw new BoardReadOnlyError();
  }

  /** Key that places a new shape above everything currently on the board. */
  nextZIndex(): string {
    return keyAbove(this.snapshot.ordered.at(-1)?.zIndex ?? null);
  }

  createShapes(shapes: readonly Shape[]): void {
    this.assertWritable();
    const validated = shapes.map((shape) => this.validate({ ...shape, updatedAt: this.now() }));
    this.transact(() => {
      for (const shape of validated) {
        if (this.yShapes.has(shape.id)) throw new Error(`Shape ${shape.id} already exists`);
        this.yShapes.set(shape.id, toYShape(shape));
      }
    });
  }

  createShape(shape: Shape): void {
    this.createShapes([shape]);
  }

  /** Applies patches atomically. Every patched shape is validated before anything is written. */
  updateShapes(updates: readonly { id: string; patch: ShapePatch }[]): void {
    this.assertWritable();
    const now = this.now();
    const planned = updates.map(({ id, patch }) => {
      const current = this.readCurrent(id);
      if (!current) throw new Error(`Shape ${id} does not exist`);
      const merged = this.validate({
        ...current,
        ...stripUndefined(patch),
        style: { ...current.style, ...stripUndefined(patch.style ?? {}) },
        updatedAt: now,
      });
      return { id, current, merged };
    });

    this.transact(() => {
      for (const { id, current, merged } of planned) {
        const yShape = this.yShapes.get(id);
        if (!yShape) continue;
        writeChangedFields(yShape, current, merged);
      }
    });
  }

  updateShape(id: string, patch: ShapePatch): void {
    this.updateShapes([{ id, patch }]);
  }

  /** Deletes shapes and any arrow bound to them (a dangling arrow has no meaning). */
  deleteShapes(ids: Iterable<string>): void {
    this.assertWritable();
    const toDelete = new Set(ids);
    for (const [id, yShape] of this.yShapes) {
      if (yShape.get("type") !== "arrow") continue;
      const from = yShape.get("fromShapeId");
      const to = yShape.get("toShapeId");
      if (
        (typeof from === "string" && toDelete.has(from)) ||
        (typeof to === "string" && toDelete.has(to))
      ) {
        toDelete.add(id);
      }
    }
    this.transact(() => {
      for (const id of toDelete) this.yShapes.delete(id);
    });
  }

  reorder(ids: Iterable<string>, mode: ReorderMode): void {
    const keys = reorderKeys(this.snapshot.ordered, new Set(ids), mode);
    if (keys.size === 0) return;
    this.updateShapes([...keys].map(([id, zIndex]) => ({ id, patch: { zIndex } })));
  }

  destroy(): void {
    this.yShapes.unobserveDeep(this.handleChanges);
    this.listeners.clear();
  }

  /**
   * Current state straight from the Y.Doc. Unlike `getShape` (the committed snapshot), this
   * sees changes made earlier in the same, still-open transaction.
   */
  private readCurrent(id: string): Shape | undefined {
    const yShape = this.yShapes.get(id);
    if (!yShape) return undefined;
    const result = shapeSchema.safeParse(yShape.toJSON());
    return result.success ? result.data : undefined;
  }

  private validate(candidate: Shape): Shape {
    const result = shapeSchema.safeParse(candidate);
    if (!result.success) throw new BoardValidationError(candidate.id, result.error.issues);
    return result.data;
  }

  private readShape(id: string): void {
    const yShape = this.yShapes.get(id);
    if (!yShape) {
      this.shapes.delete(id);
      return;
    }
    const result = shapeSchema.safeParse(yShape.toJSON());
    if (result.success) {
      this.shapes.set(id, result.data);
    } else {
      this.shapes.delete(id);
      this.onInvalidShape?.(id, new BoardValidationError(id, result.error.issues));
    }
  }

  private handleChanges = (events: Y.YEvent<Y.AbstractType<unknown>>[]): void => {
    const changed = new Set<string>();
    for (const event of events) {
      if (event.target === this.yShapes) {
        for (const key of event.changes.keys.keys()) changed.add(key);
      } else {
        const id = event.path[0];
        if (typeof id === "string") changed.add(id);
      }
    }
    if (changed.size === 0) return;
    // Re-read only the shapes that changed, so unchanged shapes keep object identity and
    // memoized renderers skip them.
    for (const id of changed) this.readShape(id);
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  };

  private buildSnapshot(): BoardSnapshot {
    const ordered = [...this.shapes.values()].sort(compareOrder);
    return { shapes: new Map(this.shapes), ordered };
  }
}

function toYShape(shape: Shape): YShape {
  const yShape = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(shape)) {
    if (key === "style") {
      yShape.set(key, toYStyle(value as ShapeStyle));
    } else {
      yShape.set(key, value);
    }
  }
  return yShape;
}

function toYStyle(style: ShapeStyle): Y.Map<unknown> {
  const yStyle = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(style)) yStyle.set(key, value);
  return yStyle;
}

/** Writes only fields whose value changed, keeping updates (and later, network traffic) small. */
function writeChangedFields(yShape: YShape, current: Shape, next: Shape): void {
  for (const [key, value] of Object.entries(next)) {
    if (key === "style") {
      const yStyle = yShape.get("style");
      if (!(yStyle instanceof Y.Map)) {
        yShape.set("style", toYStyle(value as ShapeStyle));
        continue;
      }
      for (const [styleKey, styleValue] of Object.entries(value as ShapeStyle)) {
        if (current.style[styleKey as keyof ShapeStyle] !== styleValue)
          yStyle.set(styleKey, styleValue);
      }
      continue;
    }
    const previous = (current as Record<string, unknown>)[key];
    if (!isSameValue(previous, value)) yShape.set(key, value);
  }
}

function isSameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
