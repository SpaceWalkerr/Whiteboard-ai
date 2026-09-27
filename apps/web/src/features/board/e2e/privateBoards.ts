import { useQuery } from "@tanstack/react-query";
import { boardDetailSchema, type BoardDetail } from "@whiteboard/shared/api";
import {
  base64ToBytes,
  bytesToBase64,
  createKeyCheck,
  decryptText,
  encryptText,
  generateRoomKeyString,
  importRoomKey,
  verifyKeyCheck,
  type RoomKey,
} from "@whiteboard/shared/sync";
import type { ApiClient } from "@/lib/apiClient";
import { keyFor, rememberKey } from "./keyring";

export const DEFAULT_PRIVATE_TITLE = "Untitled board";

/** What private boards can't do, and why (the server can't read them). */
export const PRIVATE_LIMITS = {
  thumbnail: "No preview: a thumbnail would show the board's content to the server.",
  search: "Private boards aren't searched: their titles are encrypted.",
  hints: "Live hints are off for private boards: they would send the board on every change.",
} as const;

/** Navigation state set by the dashboard right after creating a private board. */
export const NEW_PRIVATE_BOARD_STATE = { newPrivateBoard: true } as const;

export function isNewPrivateBoard(state: unknown): boolean {
  return (
    typeof state === "object" &&
    state !== null &&
    "newPrivateBoard" in state &&
    state.newPrivateBoard === true
  );
}

export interface UnlockedBoard {
  roomKey: RoomKey;
  /** The decrypted title. */
  title: string;
}

/**
 * Checks a key against the board's key check (so a wrong key never writes anything) and
 * decrypts the title. Returns null for a wrong or malformed key.
 */
export async function unlockBoard(
  detail: BoardDetail,
  encodedKey: string,
): Promise<UnlockedBoard | null> {
  if (!detail.keyCheck) return null;
  let roomKey: RoomKey;
  try {
    roomKey = await importRoomKey(detail.id, encodedKey);
  } catch {
    return null;
  }
  if (!(await verifyKeyCheck(roomKey, base64ToBytes(detail.keyCheck)))) return null;
  let title = "Untitled board";
  try {
    if (detail.encryptedTitle)
      title = await decryptText(roomKey, "title", base64ToBytes(detail.encryptedTitle));
  } catch {
    title = "Private board";
  }
  return { roomKey, title };
}

/**
 * Creates an end-to-end encrypted board. The key is generated here, in the browser, and
 * never sent anywhere: the server receives only the board id (chosen here, since every
 * envelope is bound to it), a key check and the encrypted title.
 */
export async function createPrivateBoard(
  api: ApiClient,
  folderId: string | null,
): Promise<{ board: BoardDetail; encodedKey: string }> {
  const id = crypto.randomUUID();
  const encodedKey = generateRoomKeyString();
  const roomKey = await importRoomKey(id, encodedKey);
  const board = await api.request("/boards", {
    method: "POST",
    body: {
      folderId,
      private: {
        id,
        keyCheck: bytesToBase64(await createKeyCheck(roomKey)),
        encryptedTitle: bytesToBase64(await encryptText(roomKey, "title", DEFAULT_PRIVATE_TITLE)),
      },
    },
    schema: boardDetailSchema,
  });
  await rememberKey(id, encodedKey);
  return { board, encodedKey };
}

/** A private board's title, decrypted with the key remembered on this device (if any). */
export async function decryptTitle(
  boardId: string,
  encryptedTitle: string | null,
): Promise<string | null> {
  const encoded = await keyFor(boardId);
  if (!encoded || !encryptedTitle) return null;
  try {
    const roomKey = await importRoomKey(boardId, encoded);
    return await decryptText(roomKey, "title", base64ToBytes(encryptedTitle));
  } catch {
    return null;
  }
}

/** Renames a private board: the new title is encrypted with its remembered key. */
export async function renamePrivateBoard(
  api: ApiClient,
  boardId: string,
  title: string,
): Promise<void> {
  const encoded = await keyFor(boardId);
  if (!encoded) throw new Error("no key for this board on this device");
  const roomKey = await importRoomKey(boardId, encoded);
  await api.request(`/boards/${boardId}`, {
    method: "PATCH",
    body: { encryptedTitle: bytesToBase64(await encryptText(roomKey, "title", title)) },
    schema: boardDetailSchema,
  });
}

/** Decrypted title for a dashboard card; null while unknown or without the key. */
export function usePrivateTitle(board: {
  id: string;
  isPrivate: boolean;
  encryptedTitle: string | null;
}): string | null {
  const title = useQuery({
    queryKey: ["private-title", board.id, board.encryptedTitle],
    queryFn: () => decryptTitle(board.id, board.encryptedTitle),
    enabled: board.isPrivate,
    staleTime: Infinity,
  });
  return title.data ?? null;
}
