import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { BoardDetail } from "@whiteboard/shared/api";
import { boardMembers, boards, boardSnapshots, eq } from "@whiteboard/shared/db";
import { audit } from "../audit/audit";
import { requireUser } from "../auth/requestAuth";
import { AppError, BadRequestError } from "../errors";
import { buildSnapshot } from "../sync/roomPersistence";
import { thumbnailPath } from "../storage/thumbnails";
import { authorize, shareTokenOf } from "./boards";
import type { ApiDeps } from "./deps";
import { parse } from "./validation";
import { ensureWorkspace } from "./workspace";

const idParams = z.object({ id: z.uuid() });
const MAX_THUMBNAIL_BYTES = 300 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

export function registerBoardExtraRoutes(app: FastifyInstance, deps: ApiDeps): void {
  // Thumbnails arrive as raw PNG bodies.
  app.addContentTypeParser(
    "image/png",
    { parseAs: "buffer", bodyLimit: MAX_THUMBNAIL_BYTES },
    (_request, body, done) => {
      done(null, body);
    },
  );

  /** Anyone who can view a board may copy it into their own workspace. */
  app.post("/boards/:id/duplicate", async (request, reply) => {
    const user = requireUser(request);
    const { id } = parse(idParams, request.params);
    const source = await authorize(deps, id, user.id, "read", {
      shareToken: shareTokenOf(request),
    });
    if (!deps.boardStore)
      throw new AppError(503, "UNAVAILABLE", "Duplicating boards is not available right now.");
    const loaded = await deps.boardStore.load(id);
    const state = buildSnapshot(
      loaded.snapshot?.state ?? null,
      loaded.updates.map((u) => u.update),
    );

    const copy = await deps.db.transaction(async (tx) => {
      const orgId = await ensureWorkspace(tx, user);
      const [created] = await tx
        .insert(boards)
        .values({
          id: crypto.randomUUID(),
          ownerId: user.id,
          orgId,
          title: `Copy of ${source.title}`.slice(0, 120),
        })
        .returning({ id: boards.id, title: boards.title, isPublic: boards.isPublic });
      if (!created) throw new Error("board insert failed");
      await tx
        .insert(boardMembers)
        .values({ boardId: created.id, userId: user.id, role: "owner", addedBy: user.id });
      // The copy starts from one snapshot of the source's current state (seq 0: no log yet).
      await tx.insert(boardSnapshots).values({ boardId: created.id, seqUpto: 0, state });
      await audit(tx, {
        action: "board.create",
        actorId: user.id,
        orgId,
        boardId: created.id,
        targetType: "board",
        targetId: created.id,
        metadata: { duplicatedFrom: id },
        ip: request.ip,
      });
      return created;
    });
    const detail: BoardDetail = { ...copy, role: "owner" };
    return reply.status(201).send(detail);
  });

  app.put("/boards/:id/thumbnail", async (request, reply) => {
    const user = requireUser(request);
    const { id } = parse(idParams, request.params);
    await authorize(deps, id, user.id, "write", { shareToken: shareTokenOf(request) });
    if (!deps.thumbnails)
      throw new AppError(503, "UNAVAILABLE", "Thumbnails are not configured on this server.");
    const body = request.body;
    if (!(body instanceof Buffer) || body.byteLength === 0 || !isPng(body)) {
      throw new BadRequestError("Expected a PNG image.");
    }
    const path = thumbnailPath(id);
    await deps.thumbnails.put(path, body);
    await deps.db.update(boards).set({ thumbnailPath: path }).where(eq(boards.id, id));
    return reply.status(204).send();
  });
}
