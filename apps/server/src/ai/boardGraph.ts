import * as Y from "yjs";
import { checkDesign, type DesignCheckResult } from "@whiteboard/graph";
import type { BoardRepository } from "../persistence/repository";

/**
 * The board's current graph, read from what the server has stored — never from the request
 * body, so what gets reviewed is exactly what is on the board. Edits reach the database
 * within the sync flush window (~50 ms); the web app waits for "Saved" before asking.
 */
export async function loadDesign(
  repository: BoardRepository,
  boardId: string,
): Promise<DesignCheckResult> {
  const loaded = await repository.load(boardId);
  const doc = new Y.Doc();
  try {
    if (loaded.snapshot) Y.applyUpdate(doc, loaded.snapshot.state);
    for (const { update } of loaded.updates) Y.applyUpdate(doc, update);
    // Plain records; extractGraph validates each one and reports anything unusable.
    // Board (z) order, like the browser's check, so references and finding order are stable.
    const records: Record<string, unknown> = doc.getMap("shapes").toJSON();
    const shapes = Object.entries(records)
      .sort(([idA, a], [idB, b]) => compare(zIndexOf(a), zIndexOf(b)) || compare(idA, idB))
      .map(([, shape]) => shape);
    return checkDesign(shapes);
  } finally {
    doc.destroy();
  }
}

export function graphSize(result: DesignCheckResult): number {
  return result.graph.nodes.length + result.graph.edges.length;
}

function zIndexOf(shape: unknown): string {
  return typeof shape === "object" &&
    shape !== null &&
    "zIndex" in shape &&
    typeof shape.zIndex === "string"
    ? shape.zIndex
    : "";
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
