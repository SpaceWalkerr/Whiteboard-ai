import { IndexeddbPersistence } from "y-indexeddb";
import type { BoardStore } from "@whiteboard/shared/board";

export const LOCAL_CACHE_PREFIX = "whiteboard:board:";

/** IndexedDB database name for a board's local copy. */
export function localCacheName(boardId: string): string {
  return `${LOCAL_CACHE_PREFIX}${boardId}`;
}

export interface LocalCache {
  /** Stops syncing with IndexedDB; the stored copy stays (for offline use). */
  detach(): void;
  /** Stops syncing and deletes the stored copy (access to the board is gone). */
  wipe(): Promise<void>;
}

/**
 * Keeps a copy of the board in this browser's IndexedDB. The board then opens instantly (and
 * offline) from the cached copy, and edits made while offline survive closing the tab; they
 * sync to the server on the next connection.
 */
export function attachLocalCache(store: BoardStore, boardId: string): LocalCache {
  const persistence = new IndexeddbPersistence(localCacheName(boardId), store.doc);
  let attached = true;
  return {
    detach: () => {
      if (!attached) return;
      attached = false;
      void persistence.destroy();
    },
    wipe: async () => {
      attached = false;
      await persistence.clearData();
    },
  };
}
