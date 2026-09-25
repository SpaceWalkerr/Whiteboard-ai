import type { IncomingMessage } from "node:http";
import { SYNC_SUBPROTOCOL, TICKET_PROTOCOL_PREFIX } from "@whiteboard/shared/sync";
import type { Database } from "@whiteboard/shared/db";
import { resolveBoardAccess, type BoardAccess } from "../access/boardAccess";
import type { TicketIssuer } from "../auth/tickets";
import type { AuthorizeConnection } from "./auth";

export function offeredProtocols(request: IncomingMessage): string[] {
  const header = request.headers["sec-websocket-protocol"];
  if (typeof header !== "string") return [];
  return header
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Production WebSocket authorization. The upgrade must offer the sync subprotocol and a valid
 * room ticket for this board. The ticket is then re-checked against the database (membership,
 * share link, public flag), so a ticket issued before an access change can't be used after it.
 * The effective role is the lower of the ticket's role and the current one.
 */
export function ticketAuthorizer(tickets: TicketIssuer, db: Database): AuthorizeConnection {
  return async (request, boardId) => {
    const protocols = offeredProtocols(request);
    const offered = protocols.find((p) => p.startsWith(TICKET_PROTOCOL_PREFIX));
    if (!protocols.includes(SYNC_SUBPROTOCOL) || offered === undefined)
      return { ok: false, status: 401 };

    let claims;
    try {
      claims = await tickets.verify(offered.slice(TICKET_PROTOCOL_PREFIX.length), boardId);
    } catch {
      return { ok: false, status: 401 };
    }

    const current = await resolveBoardAccess(db, boardId, {
      userId: claims.userId,
      linkId: claims.linkId,
    });
    if (!current || current.deleted || current.role === null) return { ok: false, status: 403 };
    if (claims.viaPublic && !current.isPublic && current.via === "public")
      return { ok: false, status: 403 };
    const role = lowerRole(claims.role, current);
    return {
      ok: true,
      identity: { userId: claims.userId, role, linkId: claims.linkId, viaPublic: claims.viaPublic },
    };
  };
}

function lowerRole(
  ticketRole: "owner" | "editor" | "viewer",
  current: BoardAccess,
): "owner" | "editor" | "viewer" {
  const rank = { viewer: 1, editor: 2, owner: 3 } as const;
  const now = current.role ?? "viewer";
  return rank[ticketRole] <= rank[now] ? ticketRole : now;
}
