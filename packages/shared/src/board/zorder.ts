import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

/**
 * Z-order uses fractional-index keys stored on each shape (not a Y.Array), so concurrent
 * reorders from different clients can never duplicate or lose a shape. Two clients can
 * produce the same key; ties are broken by id, which every client agrees on.
 */

export interface Ordered {
  id: string;
  zIndex: string;
}

export function compareOrder(a: Ordered, b: Ordered): number {
  if (a.zIndex < b.zIndex) return -1;
  if (a.zIndex > b.zIndex) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function keyAbove(top: string | null): string {
  return generateKeyBetween(top, null);
}

export function keysAbove(top: string | null, count: number): string[] {
  return generateNKeysBetween(top, null, count);
}

export type ReorderMode = "front" | "back" | "forward" | "backward";

/**
 * Returns new zIndex keys for the shapes that move. `ordered` is the full board in render
 * order. Only moved shapes get new keys; everything else keeps its key.
 */
export function reorderKeys(
  ordered: readonly Ordered[],
  ids: ReadonlySet<string>,
  mode: ReorderMode,
): Map<string, string> {
  const moving = ordered.filter((s) => ids.has(s.id));
  if (moving.length === 0) return new Map();
  const rest = ordered.filter((s) => !ids.has(s.id));

  let target: Ordered[];
  switch (mode) {
    case "front":
      target = [...rest, ...moving];
      break;
    case "back":
      target = [...moving, ...rest];
      break;
    case "forward":
      target = stepForward(ordered, ids);
      break;
    case "backward":
      target = stepForward([...ordered].reverse(), ids).reverse();
      break;
  }
  return assignKeys(target, ids);
}

/** Moves each selected shape one position up, past the next unselected shape. */
function stepForward(ordered: readonly Ordered[], ids: ReadonlySet<string>): Ordered[] {
  const result = [...ordered];
  for (let i = result.length - 2; i >= 0; i--) {
    const current = result[i];
    const next = result[i + 1];
    if (current && next && ids.has(current.id) && !ids.has(next.id)) {
      result[i] = next;
      result[i + 1] = current;
    }
  }
  return result;
}

/** Gives each run of moved shapes keys between its unmoved neighbours. */
function assignKeys(target: readonly Ordered[], moved: ReadonlySet<string>): Map<string, string> {
  const keys = new Map<string, string>();
  let i = 0;
  while (i < target.length) {
    const item = target[i];
    if (!item || !moved.has(item.id)) {
      i++;
      continue;
    }
    let end = i;
    while (end < target.length && moved.has(target[end]?.id ?? "")) end++;
    const before = i > 0 ? (target[i - 1]?.zIndex ?? null) : null;
    const after = end < target.length ? (target[end]?.zIndex ?? null) : null;
    if (before !== null && after !== null && before >= after) {
      // Neighbours share a key (possible after concurrent edits): renumber the whole board.
      return renumber(target);
    }
    const runKeys = generateNKeysBetween(before, after, end - i);
    for (let k = i; k < end; k++) {
      const shape = target[k];
      const key = runKeys[k - i];
      if (shape && key) keys.set(shape.id, key);
    }
    i = end;
  }
  return keys;
}

function renumber(target: readonly Ordered[]): Map<string, string> {
  const keys = generateNKeysBetween(null, null, target.length);
  return new Map(target.map((shape, index) => [shape.id, keys[index] ?? ""]));
}
