import { IndexeddbPersistence } from "y-indexeddb";
import type { BoardStore } from "@whiteboard/shared/board";

/** IndexedDB database name for a board's local copy. */
export function localCacheName(boardId: string): string {
  return `whiteboard:board:${boardId}`;
}

/**
 * Keeps a copy of the board in this browser's IndexedDB. The board then opens instantly (and
 * offline) from the cached copy, and edits made while offline survive closing the tab; they
 * sync to the server on the next connection. Returns a function that detaches the cache
 * (the stored copy stays).
 */
export function attachLocalCache(store: BoardStore, boardId: string): () => void {
  const persistence = new IndexeddbPersistence(localCacheName(boardId), store.doc);
  return () => {
    void persistence.destroy();
  };
}
