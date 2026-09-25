import { LOCAL_CACHE_PREFIX } from "@/features/board/sync/localCache";

import { boardDetailSchema, type BoardDetail } from "@whiteboard/shared/api";

const SHARE_TOKEN_PREFIX = "whiteboard.share.";
const BOARD_DETAIL_PREFIX = "whiteboard.board.";
const RETURN_TO_KEY = "whiteboard.returnTo";

/** Share-link tokens live for this browser tab session only, keyed by board. */
export function rememberShareToken(boardId: string, token: string): void {
  try {
    sessionStorage.setItem(`${SHARE_TOKEN_PREFIX}${boardId}`, token);
  } catch {
    // Not persisted; the link still works on this page.
  }
}

export function shareTokenFor(boardId: string): string | undefined {
  try {
    return sessionStorage.getItem(`${SHARE_TOKEN_PREFIX}${boardId}`) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Last known title/role per board, so a cached board can open offline. */
export function rememberBoardDetail(detail: BoardDetail): void {
  try {
    localStorage.setItem(`${BOARD_DETAIL_PREFIX}${detail.id}`, JSON.stringify(detail));
  } catch {
    // ignore
  }
}

export function cachedBoardDetail(boardId: string): BoardDetail | null {
  try {
    const raw: unknown = JSON.parse(
      localStorage.getItem(`${BOARD_DETAIL_PREFIX}${boardId}`) ?? "null",
    );
    const parsed = boardDetailSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Where to go after signing in (only same-origin paths, never full URLs). */
export function rememberReturnTo(path: string): void {
  if (!path.startsWith("/") || path.startsWith("//")) return;
  try {
    sessionStorage.setItem(RETURN_TO_KEY, path);
  } catch {
    // ignore
  }
}

export function takeReturnTo(): string {
  try {
    const value = sessionStorage.getItem(RETURN_TO_KEY);
    sessionStorage.removeItem(RETURN_TO_KEY);
    if (value?.startsWith("/") && !value.startsWith("//")) return value;
  } catch {
    // ignore
  }
  return "/app";
}

/**
 * Removes everything this app keeps on the device for the signed-in user: offline board
 * copies (IndexedDB), cached board details and share tokens. Called on sign-out.
 */
export async function clearLocalBoardData(): Promise<void> {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(SHARE_TOKEN_PREFIX)) sessionStorage.removeItem(key);
    }
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(BOARD_DETAIL_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // ignore
  }
  if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return;
  const databases = await indexedDB.databases();
  await Promise.all(
    databases
      .map((db) => db.name)
      .filter((name): name is string => name?.startsWith(LOCAL_CACHE_PREFIX) === true)
      .map(
        (name) =>
          new Promise<void>((resolve) => {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = () => {
              resolve();
            };
            request.onerror = () => {
              resolve();
            };
            request.onblocked = () => {
              resolve();
            };
          }),
      ),
  );
}
