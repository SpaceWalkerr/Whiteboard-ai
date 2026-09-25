import { z } from "zod";
import { shapeSchema, type Shape } from "./shapes";

/**
 * Clipboard format for copy/paste, including between boards and browser tabs. It is plain
 * JSON text so it survives the system clipboard; it is validated on the way back in because
 * anything can be on the clipboard.
 */
export const CLIPBOARD_KIND = "whiteboard-ai/shapes";

const clipboardPayloadSchema = z.object({
  kind: z.literal(CLIPBOARD_KIND),
  version: z.literal(1),
  shapes: z.array(shapeSchema).min(1).max(5000),
});

/**
 * Callers should first "freeze" arrows bound to shapes outside the copied set (set their
 * start/end to the rendered position), so pasted arrows keep their shape when unbound.
 */
export function serializeClipboard(shapes: readonly Shape[]): string {
  return JSON.stringify({ kind: CLIPBOARD_KIND, version: 1, shapes });
}

/** Returns the shapes if `text` is our clipboard format, otherwise null. */
export function parseClipboard(text: string): Shape[] | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const result = clipboardPayloadSchema.safeParse(json);
  return result.success ? result.data.shapes : null;
}

export interface CloneOptions {
  offset: { x: number; y: number };
  /** New zIndex keys in ascending order, one per shape (keeps relative order). */
  zIndexKeys: readonly string[];
  userId: string;
  now: number;
  newId?: () => string;
}

/**
 * Clones shapes for paste/duplicate: fresh ids, fresh group ids, shifted positions, new
 * z-order. Arrows bound to shapes inside the set are re-bound to the clones; bindings to
 * shapes outside the set are dropped (the arrow keeps its frozen start/end points).
 * `shapes` must be in render order.
 */
export function cloneShapes(shapes: readonly Shape[], options: CloneOptions): Shape[] {
  const newId = options.newId ?? (() => globalThis.crypto.randomUUID());
  const idMap = new Map(shapes.map((shape) => [shape.id, newId()]));
  const groupMap = new Map<string, string>();
  const { x: dx, y: dy } = options.offset;

  return shapes.map((shape, index) => {
    const id = idMap.get(shape.id) ?? newId();
    let groupId: string | null = null;
    if (shape.groupId !== null) {
      groupId = groupMap.get(shape.groupId) ?? newId();
      groupMap.set(shape.groupId, groupId);
    }
    const common = {
      id,
      groupId,
      x: shape.x + dx,
      y: shape.y + dy,
      zIndex: options.zIndexKeys[index] ?? shape.zIndex,
      createdBy: options.userId,
      updatedAt: options.now,
    };
    if (shape.type !== "arrow") return { ...shape, ...common };

    const fromShapeId = shape.fromShapeId === null ? null : (idMap.get(shape.fromShapeId) ?? null);
    const toShapeId = shape.toShapeId === null ? null : (idMap.get(shape.toShapeId) ?? null);
    return {
      ...shape,
      ...common,
      fromShapeId,
      toShapeId,
      fromAnchor: fromShapeId === null ? "auto" : shape.fromAnchor,
      toAnchor: toShapeId === null ? "auto" : shape.toAnchor,
      start: { x: shape.start.x + dx, y: shape.start.y + dy },
      end: { x: shape.end.x + dx, y: shape.end.y + dy },
    };
  });
}
