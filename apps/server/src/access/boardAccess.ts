import { createHash } from "node:crypto";
import type { BoardRole } from "@whiteboard/shared/api";
import {
  and,
  boardMembers,
  boards,
  eq,
  memberships,
  shareLinks,
  sql,
  type Database,
} from "@whiteboard/shared/db";

export type BoardAction = "read" | "write" | "share" | "delete";

const RANK: Record<BoardRole, number> = { viewer: 1, editor: 2, owner: 3 };

/** The single permission table, used by REST routes and the WebSocket alike. */
const REQUIRED: Record<BoardAction, BoardRole> = {
  read: "viewer",
  write: "editor",
  share: "owner",
  delete: "owner",
};

export function can(role: BoardRole | null, action: BoardAction): boolean {
  return role !== null && RANK[role] >= RANK[REQUIRED[action]];
}

export function higherRole(a: BoardRole | null, b: BoardRole | null): BoardRole | null {
  if (a === null) return b;
  if (b === null) return a;
  return RANK[a] >= RANK[b] ? a : b;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface BoardAccess {
  boardId: string;
  orgId: string | null;
  title: string;
  isPublic: boolean;
  deleted: boolean;
  /** Effective role, or null when the caller has no access at all. */
  role: BoardRole | null;
  /** Where the effective role came from. */
  via: "member" | "org" | "link" | "public" | null;
  linkId: string | null;
}

/**
 * Effective role of a caller on a board: the highest of direct membership, workspace role
 * (workspace owner/admin act as board owner), a valid share link (signed-in callers only) and
 * public read-only access. Returns null if the board does not exist.
 */
export async function resolveBoardAccess(
  db: Database,
  boardId: string,
  caller: { userId: string | null; shareToken?: string | null; linkId?: string | null },
): Promise<BoardAccess | null> {
  const [board] = await db
    .select({
      id: boards.id,
      orgId: boards.orgId,
      title: boards.title,
      isPublic: boards.isPublic,
      deletedAt: boards.deletedAt,
    })
    .from(boards)
    .where(eq(boards.id, boardId));
  if (!board) return null;

  const access: BoardAccess = {
    boardId,
    orgId: board.orgId,
    title: board.title,
    isPublic: board.isPublic,
    deleted: board.deletedAt !== null,
    role: null,
    via: null,
    linkId: null,
  };
  const offer = (
    role: BoardRole | null,
    via: NonNullable<BoardAccess["via"]>,
    linkId: string | null = null,
  ) => {
    if (role !== null && higherRole(access.role, role) === role && role !== access.role) {
      access.role = role;
      access.via = via;
      access.linkId = linkId;
    }
  };

  if (caller.userId !== null) {
    const [member] = await db
      .select({ role: boardMembers.role })
      .from(boardMembers)
      .where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, caller.userId)));
    offer(member?.role ?? null, "member");

    if (board.orgId !== null) {
      const [membership] = await db
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.orgId, board.orgId), eq(memberships.userId, caller.userId)));
      if (membership?.role === "owner" || membership?.role === "admin") offer("owner", "org");
    }

    // Share links require a signed-in caller, so every use is attributable.
    const linkCondition = caller.shareToken
      ? eq(shareLinks.tokenHash, hashToken(caller.shareToken))
      : caller.linkId
        ? eq(shareLinks.id, caller.linkId)
        : null;
    if (linkCondition) {
      const [link] = await db
        .select({ id: shareLinks.id, role: shareLinks.role })
        .from(shareLinks)
        .where(
          and(
            linkCondition,
            eq(shareLinks.boardId, boardId),
            sql`${shareLinks.revokedAt} is null`,
            sql`(${shareLinks.expiresAt} is null or ${shareLinks.expiresAt} > now())`,
          ),
        );
      if (link) offer(link.role, "link", link.id);
    }
  }

  if (board.isPublic) offer("viewer", "public");
  return access;
}
