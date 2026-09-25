import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  boardListQuerySchema,
  createBoardSchema,
  ticketRequestSchema,
  updateBoardSchema,
  type BoardDetail,
  type BoardSummary,
  type TicketResponse,
} from "@whiteboard/shared/api";
import { and, boardMembers, boards, boardVisits, eq, folders, sql } from "@whiteboard/shared/db";
import { can, resolveBoardAccess, type BoardAccess, type BoardAction } from "../access/boardAccess";
import { audit } from "../audit/audit";
import { requireUser } from "../auth/requestAuth";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "../errors";
import type { ApiDeps } from "./deps";
import { parse } from "./validation";
import { THUMBNAIL_URL_TTL_SECONDS } from "../storage/thumbnails";
import { ensureWorkspace } from "./workspace";

const idParams = z.object({ id: z.uuid() });
export const TRASH_RETENTION_DAYS = 30;

/**
 * Loads the caller's access and enforces `action`. Missing or deleted boards are 404 (deleted
 * boards are visible only to `delete`-level callers, for restore); no access is 401 for
 * signed-out callers and 403 otherwise.
 */
export async function authorize(
  deps: ApiDeps,
  boardId: string,
  userId: string | null,
  action: BoardAction,
  options: { shareToken?: string | undefined; allowDeleted?: boolean } = {},
): Promise<BoardAccess & { role: NonNullable<BoardAccess["role"]> }> {
  const access = await resolveBoardAccess(deps.db, boardId, {
    userId,
    shareToken: options.shareToken ?? null,
  });
  if (!access || (access.deleted && !options.allowDeleted))
    throw new NotFoundError("Board not found");
  if (access.role === null) {
    if (userId === null) throw new UnauthorizedError();
    throw new ForbiddenError("You don't have access to this board.");
  }
  if (!can(access.role, action)) throw new ForbiddenError();
  return { ...access, role: access.role };
}

/** Share-link token presented by link users (header, so it never lands in URLs or logs). */
export function shareTokenOf(request: FastifyRequest): string | undefined {
  const header = request.headers["x-share-token"];
  return typeof header === "string" && header.length > 0 ? header : undefined;
}

export function registerBoardRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get("/boards", async (request): Promise<{ boards: BoardSummary[] }> => {
    const user = requireUser(request);
    const query = parse(boardListQuerySchema, request.query);
    const search = query.q
      ? sql`and b.title ilike ${`%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}`
      : sql``;
    const folder = query.folderId ? sql`and b.folder_id = ${query.folderId}` : sql``;
    const trash = query.view === "trash";
    const viewFilter =
      query.view === "mine"
        ? sql`and m.role = 'owner'`
        : query.view === "shared"
          ? sql`and m.role <> 'owner'`
          : query.view === "recent"
            ? sql`and v.last_opened_at is not null`
            : sql`and m.role = 'owner'`;
    const deletedFilter = trash
      ? sql`and b.deleted_at is not null and b.deleted_at > now() - make_interval(days => ${TRASH_RETENTION_DAYS})`
      : sql`and b.deleted_at is null`;
    const order = query.view === "recent" ? sql`v.last_opened_at desc` : sql`b.updated_at desc`;

    const rows = await deps.db.execute<{
      id: string;
      title: string;
      role: "owner" | "editor" | "viewer";
      folder_id: string | null;
      is_public: boolean;
      updated_at: string;
      deleted_at: string | null;
      last_opened_at: string | null;
      thumbnail_path: string | null;
    }>(sql`
      select b.id, b.title, m.role, b.folder_id, b.is_public, b.updated_at::text, b.deleted_at::text,
             v.last_opened_at::text, b.thumbnail_path
      from ${boardMembers} m
      join ${boards} b on b.id = m.board_id
      left join ${boardVisits} v on v.board_id = b.id and v.user_id = m.user_id
      where m.user_id = ${user.id} ${viewFilter} ${deletedFilter} ${search} ${folder}
      order by ${order}
      limit 200`);
    const paths = rows.flatMap((r) => (r.thumbnail_path ? [r.thumbnail_path] : []));
    const urls = deps.thumbnails
      ? await deps.thumbnails
          .signedUrls(paths, THUMBNAIL_URL_TTL_SECONDS)
          .catch((error: unknown) => {
            deps.logger.warn({ err: error }, "could not sign thumbnail URLs");
            return new Map<string, string>();
          })
      : new Map<string, string>();
    return {
      boards: rows.map((r) => ({
        id: r.id,
        title: r.title,
        role: r.role,
        folderId: r.folder_id,
        isPublic: r.is_public,
        updatedAt: r.updated_at,
        deletedAt: r.deleted_at,
        lastOpenedAt: r.last_opened_at,
        thumbnailUrl: r.thumbnail_path ? (urls.get(r.thumbnail_path) ?? null) : null,
      })),
    };
  });

  app.post("/boards", async (request, reply) => {
    const user = requireUser(request);
    const body = parse(createBoardSchema, request.body ?? {});
    const board = await deps.db.transaction(async (tx) => {
      const orgId = await ensureWorkspace(tx, user);
      if (body.folderId) {
        const [folder] = await tx
          .select({ id: folders.id })
          .from(folders)
          .where(and(eq(folders.id, body.folderId), eq(folders.orgId, orgId)));
        if (!folder) throw new NotFoundError("Folder not found");
      }
      const [created] = await tx
        .insert(boards)
        .values({
          id: crypto.randomUUID(),
          ownerId: user.id,
          orgId,
          title: body.title ?? "Untitled board",
          folderId: body.folderId ?? null,
        })
        .returning({ id: boards.id, title: boards.title, isPublic: boards.isPublic });
      if (!created) throw new Error("board insert failed");
      await tx
        .insert(boardMembers)
        .values({ boardId: created.id, userId: user.id, role: "owner", addedBy: user.id });
      await audit(tx, {
        action: "board.create",
        actorId: user.id,
        orgId,
        boardId: created.id,
        targetType: "board",
        targetId: created.id,
        ip: request.ip,
      });
      return created;
    });
    const detail: BoardDetail = { ...board, role: "owner" };
    return reply.status(201).send(detail);
  });

  app.get("/boards/:id", async (request): Promise<BoardDetail> => {
    const { id } = parse(idParams, request.params);
    const access = await authorize(deps, id, request.user?.id ?? null, "read", {
      shareToken: shareTokenOf(request),
    });
    return {
      id: access.boardId,
      title: access.title,
      role: access.role,
      isPublic: access.isPublic,
    };
  });

  app.patch("/boards/:id", async (request): Promise<BoardDetail> => {
    const user = requireUser(request);
    const { id } = parse(idParams, request.params);
    const body = parse(updateBoardSchema, request.body);
    // Renaming is editing; moving between workspace folders is an owner action.
    const access = await authorize(
      deps,
      id,
      user.id,
      body.folderId !== undefined ? "share" : "write",
      {
        shareToken: shareTokenOf(request),
      },
    );
    if (body.folderId && access.orgId) {
      const [folder] = await deps.db
        .select({ id: folders.id })
        .from(folders)
        .where(and(eq(folders.id, body.folderId), eq(folders.orgId, access.orgId)));
      if (!folder) throw new NotFoundError("Folder not found");
    }
    const [updated] = await deps.db
      .update(boards)
      .set({
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.folderId !== undefined ? { folderId: body.folderId } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(boards.id, id))
      .returning({ title: boards.title, isPublic: boards.isPublic });
    return {
      id,
      title: updated?.title ?? access.title,
      role: access.role,
      isPublic: updated?.isPublic ?? access.isPublic,
    };
  });

  app.delete("/boards/:id", async (request, reply) => {
    const user = requireUser(request);
    const { id } = parse(idParams, request.params);
    const access = await authorize(deps, id, user.id, "delete");
    await deps.db.transaction(async (tx) => {
      await tx
        .update(boards)
        .set({ deletedAt: sql`now()` })
        .where(eq(boards.id, id));
      await audit(tx, {
        action: "board.delete",
        actorId: user.id,
        orgId: access.orgId,
        boardId: id,
        targetType: "board",
        targetId: id,
        metadata: { soft: true },
        ip: request.ip,
      });
    });
    await deps.revocations.publish({ type: "board_deleted", boardId: id });
    return reply.status(204).send();
  });

  app.post("/boards/:id/restore", async (request): Promise<BoardDetail> => {
    const user = requireUser(request);
    const { id } = parse(idParams, request.params);
    const access = await authorize(deps, id, user.id, "delete", { allowDeleted: true });
    if (!access.deleted)
      return { id, title: access.title, role: access.role, isPublic: access.isPublic };
    await deps.db.transaction(async (tx) => {
      const restored = await tx
        .update(boards)
        .set({ deletedAt: null })
        .where(
          and(
            eq(boards.id, id),
            sql`${boards.deletedAt} > now() - make_interval(days => ${TRASH_RETENTION_DAYS})`,
          ),
        )
        .returning({ id: boards.id });
      if (restored.length === 0)
        throw new NotFoundError("This board was deleted more than 30 days ago.");
      await audit(tx, {
        action: "board.restore",
        actorId: user.id,
        orgId: access.orgId,
        boardId: id,
        targetType: "board",
        targetId: id,
        ip: request.ip,
      });
    });
    return { id, title: access.title, role: access.role, isPublic: access.isPublic };
  });

  /**
   * Room ticket for the WebSocket: issued only after checking the Supabase session (or public
   * access) and the board role. Opening a board is recorded for "Recent".
   */
  app.post(
    "/boards/:id/ticket",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request): Promise<TicketResponse> => {
      const { id } = parse(idParams, request.params);
      const body = parse(ticketRequestSchema, request.body ?? {});
      const userId = request.user?.id ?? null;
      const access = await authorize(deps, id, userId, "read", { shareToken: body.shareToken });
      const { ticket, expiresAt } = await deps.tickets.issue({
        userId,
        boardId: id,
        role: access.role,
        linkId: access.via === "link" ? access.linkId : null,
        viaPublic: access.via === "public",
      });
      if (userId !== null) {
        await deps.db
          .insert(boardVisits)
          .values({ userId, boardId: id })
          .onConflictDoUpdate({
            target: [boardVisits.userId, boardVisits.boardId],
            set: { lastOpenedAt: sql`now()` },
          });
      }
      return { ticket, role: access.role, expiresAt: expiresAt.toISOString() };
    },
  );
}
