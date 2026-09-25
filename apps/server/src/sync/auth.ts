import type { IncomingMessage } from "node:http";

export type BoardRole = "viewer" | "editor";

export interface ConnectionIdentity {
  /** Authenticated user id; null until Phase 4 adds sign-in. */
  userId: string | null;
  role: BoardRole;
}

export type AuthorizationResult =
  { ok: true; identity: ConnectionIdentity } | { ok: false; status: 401 | 403 };

/**
 * Decides whether a WebSocket upgrade for `boardId` may proceed, and with which role. Runs
 * before the socket is accepted. Phase 4 replaces the implementation with
 * verifyToken(boardId, token) → role; nothing else in the sync module needs to change.
 */
export type AuthorizeConnection = (
  request: IncomingMessage,
  boardId: string,
) => Promise<AuthorizationResult>;

/**
 * TEMPORARY (Phase 2 only): every connection is an anonymous editor. Boards are only reachable
 * by their unguessable id until real authentication lands in Phase 4.
 */
export const allowAllConnections: AuthorizeConnection = () =>
  Promise.resolve({ ok: true, identity: { userId: null, role: "editor" } });
