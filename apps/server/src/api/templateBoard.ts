import * as Y from "yjs";
import { BoardStore } from "@whiteboard/shared/board";
import type { BoardTemplate } from "@whiteboard/shared/templates";

/**
 * The Y.Doc state of a new board that starts as `template`, stored as the board's first
 * snapshot (like a duplicate), so the first client to open it syncs the shapes from the server.
 * The shapes are the requester's, as if they had drawn them.
 */
export function templateBoardState(
  template: BoardTemplate,
  userId: string,
  now: number,
): Uint8Array {
  const doc = new Y.Doc();
  const store = new BoardStore({ doc, userId, now: () => now });
  store.createShapes(template.shapes.map((shape) => ({ ...shape, createdBy: userId })));
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}
