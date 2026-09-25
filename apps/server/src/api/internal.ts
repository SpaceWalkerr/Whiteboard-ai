import type { FastifyInstance } from "fastify";
import { boards, eq, lt, sql } from "@whiteboard/shared/db";
import { audit } from "../audit/audit";
import { UnauthorizedError } from "../errors";
import { TRASH_RETENTION_DAYS } from "./boards";
import type { ApiDeps } from "./deps";

/**
 * Internal endpoints for scheduled jobs (Render Cron Jobs). They live outside the user API
 * scope: they are authenticated by CRON_SECRET, never by a user session.
 */
export function registerInternalRoutes(app: FastifyInstance, deps: ApiDeps): void {
  /**
   * Hard-deletes boards that have been in the trash for more than 30 days (content, history
   * and thumbnail). Called by a Render Cron Job with the CRON_SECRET bearer token.
   */
  app.post("/internal/purge-trash", async (request) => {
    if (!deps.cronSecret || request.headers.authorization !== `Bearer ${deps.cronSecret}`) {
      throw new UnauthorizedError("A valid cron secret is required.");
    }
    const expired = await deps.db
      .select({ id: boards.id, orgId: boards.orgId, thumbnailPath: boards.thumbnailPath })
      .from(boards)
      .where(lt(boards.deletedAt, sql`now() - make_interval(days => ${TRASH_RETENTION_DAYS})`))
      .limit(500);
    for (const board of expired) {
      await deps.db.transaction(async (tx) => {
        await audit(tx, {
          action: "board.purge",
          actorId: null,
          orgId: board.orgId,
          boardId: board.id,
          targetType: "board",
          targetId: board.id,
          metadata: { reason: "trash retention expired" },
        });
        await tx.delete(boards).where(eq(boards.id, board.id));
      });
      if (board.thumbnailPath && deps.thumbnails) {
        await deps.thumbnails.remove([board.thumbnailPath]).catch((error: unknown) => {
          deps.logger.warn(
            { err: error, boardId: board.id },
            "could not delete thumbnail of purged board",
          );
        });
      }
      await deps.revocations.publish({ type: "board_deleted", boardId: board.id });
    }
    return { purged: expired.length };
  });
}
