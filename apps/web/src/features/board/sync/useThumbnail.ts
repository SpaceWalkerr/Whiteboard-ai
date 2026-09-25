import { useEffect } from "react";
import type { BoardStore } from "@whiteboard/shared/board";
import type { ApiClient } from "@/lib/apiClient";
import { renderThumbnail } from "../export/download";

const IDLE_MS = 5_000;
const MIN_INTERVAL_MS = 60_000;
const MAX_BYTES = 300 * 1024;

/**
 * Keeps the dashboard thumbnail fresh: after this user's own edits settle (5 s idle), renders
 * the board to a small PNG and uploads it, at most once a minute. Only editors do this, and
 * only for their own changes, so a busy board isn't re-rendered by every open client.
 */
export function useThumbnail(options: {
  store: BoardStore;
  boardId: string;
  api: ApiClient;
  enabled: boolean;
  shareToken?: string | undefined;
}): void {
  const { store, boardId, api, enabled, shareToken } = options;
  useEffect(() => {
    if (!enabled) return;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastUpload = 0;
    let uploading = false;

    const upload = async () => {
      if (uploading || !navigator.onLine) return;
      uploading = true;
      try {
        const png = await renderThumbnail(store.getSnapshot().ordered, 480, 300);
        if (!png || png.size > MAX_BYTES) return;
        await api.upload(`/boards/${boardId}/thumbnail`, { method: "PUT", body: png, shareToken });
        lastUpload = Date.now();
      } catch {
        // A thumbnail is cosmetic; try again after the next edit.
      } finally {
        uploading = false;
      }
    };

    const onUpdate = (_update: Uint8Array, origin: unknown) => {
      if (origin !== store.localOrigin) return;
      if (idleTimer) clearTimeout(idleTimer);
      const wait = Math.max(IDLE_MS, lastUpload + MIN_INTERVAL_MS - Date.now());
      idleTimer = setTimeout(() => {
        idleTimer = null;
        void upload();
      }, wait);
    };
    store.doc.on("update", onUpdate);
    return () => {
      store.doc.off("update", onUpdate);
      if (idleTimer) clearTimeout(idleTimer);
    };
  }, [store, boardId, api, enabled, shareToken]);
}
