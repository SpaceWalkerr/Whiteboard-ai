import type { IncomingMessage } from "node:http";
import type { BoardRole } from "@whiteboard/shared/api";

export interface ConnectionIdentity {
  /** Authenticated user id; null for anonymous viewers of public boards (and in tests). */
  userId: string | null;
  role: BoardRole;
  /** Share link the access came from (revoking it ends the session). */
  linkId: string | null;
  /** Access only because the board is public (turning that off ends the session). */
  viaPublic: boolean;
}

export type AuthorizationResult =
  { ok: true; identity: ConnectionIdentity } | { ok: false; status: 401 | 403 };

/**
 * Decides whether a WebSocket upgrade for `boardId` may proceed, and with which role. Runs
 * before the socket is accepted. Production uses `ticketAuthorizer` (room ticket + database
 * re-check).
 */
export type AuthorizeConnection = (
  request: IncomingMessage,
  boardId: string,
) => Promise<AuthorizationResult>;

/** Test helper only: every connection is an anonymous editor. Never used by the server. */
export const allowAllConnections: AuthorizeConnection = () =>
  Promise.resolve({
    ok: true,
    identity: { userId: null, role: "editor", linkId: null, viaPublic: false },
  });
