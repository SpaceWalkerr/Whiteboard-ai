import * as Y from "yjs";

/**
 * The updates that applying `state` to the board made of `snapshot` + `updates` would add
 * (empty: nothing missing). Exact, deletions included — unlike a state-vector diff, since
 * deleting doesn't advance a state vector.
 */
export function missingFrom(
  snapshot: Uint8Array | null,
  updates: readonly Uint8Array[],
  state: Uint8Array,
): Uint8Array[] {
  const stored = new Y.Doc();
  if (snapshot) Y.applyUpdate(stored, snapshot);
  for (const update of updates) Y.applyUpdate(stored, update);
  const missing: Uint8Array[] = [];
  // Yjs emits "update" only for changes that are new to this document.
  stored.on("update", (update: Uint8Array) => missing.push(update));
  Y.applyUpdate(stored, state);
  stored.destroy();
  return missing;
}
