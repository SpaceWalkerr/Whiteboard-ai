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
  const { userId } = caller;
  // Share links require a signed-in caller, so every use is attributable.
  const linkMatch =
    userId === null
      ? null
      : caller.shareToken
        ? eq(shareLinks.tokenHash, hashToken(caller.shareToken))
        : caller.linkId
          ? eq(shareLinks.id, caller.linkId)
          : null;
  // One round trip: this runs on every API request and every socket upgrade, and each
  // extra query costs a full database round trip. Every join is on a unique key, so there is
  // at most one row.
  const [row] = await db
    .select({
      orgId: boards.orgId,
      title: boards.title,
      isPublic: boards.isPublic,
      deletedAt: boards.deletedAt,
      memberRole: boardMembers.role,
      orgRole: memberships.role,
      linkId: shareLinks.id,
      linkRole: shareLinks.role,
    })
    .from(boards)
    .leftJoin(
      boardMembers,
      userId === null
        ? sql`false`
        : and(eq(boardMembers.boardId, boards.id), eq(boardMembers.userId, userId)),
    )
    .leftJoin(
      memberships,
      userId === null
        ? sql`false`
        : and(eq(memberships.orgId, boards.orgId), eq(memberships.userId, userId)),
    )
    .leftJoin(
      shareLinks,
      linkMatch === null
        ? sql`false`
        : and(
            linkMatch,
            eq(shareLinks.boardId, boards.id),
            sql`${shareLinks.revokedAt} is null`,
            sql`(${shareLinks.expiresAt} is null or ${shareLinks.expiresAt} > now())`,
          ),
    )
    .where(eq(boards.id, boardId));
  if (!row) return null;

  const access: BoardAccess = {
    boardId,
    orgId: row.orgId,
    title: row.title,
    isPublic: row.isPublic,
    deleted: row.deletedAt !== null,
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

  offer(row.memberRole, "member");
  if (row.orgRole === "owner" || row.orgRole === "admin") offer("owner", "org");
  if (row.linkId !== null) offer(row.linkRole, "link", row.linkId);
  if (row.isPublic) offer("viewer", "public");
  return access;
}
