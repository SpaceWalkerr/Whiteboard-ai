import { ROOM_KEY_BYTES, base64UrlToBytes } from "@whiteboard/shared/sync";

/**
 * Private boards carry their key in the URL fragment: `/board/<id>#key=<base64url>`.
 * Browsers never send the fragment to servers (not in requests, not in Referer headers), so
 * neither our API, the sync server, Vercel nor any proxy ever sees the key.
 */
export const KEY_PARAM = "key";

function isKey(value: string): boolean {
  try {
    return base64UrlToBytes(value).byteLength === ROOM_KEY_BYTES;
  } catch {
    return false;
  }
}

/** The key in a location hash ("#key=…"), or null when absent or malformed. */
export function keyFromHash(hash: string): string | null {
  const value = new URLSearchParams(hash.replace(/^#/, "")).get(KEY_PARAM);
  return value !== null && isKey(value) ? value : null;
}

/** `url` with its fragment set to the key (replacing any other fragment). */
export function withKey(url: string, encodedKey: string): string {
  return `${url.split("#")[0] ?? url}#${KEY_PARAM}=${encodedKey}`;
}

export function boardLinkWithKey(origin: string, boardId: string, encodedKey: string): string {
  return withKey(`${origin}/board/${boardId}`, encodedKey);
}

/**
 * The key from what someone pasted: a full board link (it must be for this board) or just
 * the key itself.
 */
export function keyFromPasted(text: string, boardId: string): string | null {
  const trimmed = text.trim();
  if (isKey(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/\/$/, "");
    if (path !== `/board/${boardId}` && !path.startsWith("/s/")) return null;
    return keyFromHash(url.hash);
  } catch {
    return null;
  }
}
