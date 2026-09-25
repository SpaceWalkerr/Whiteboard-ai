import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, eq, folders } from "@whiteboard/shared/db";
import { requireUser } from "../auth/requestAuth";
import { NotFoundError } from "../errors";
import type { ApiDeps } from "./deps";
import { parse } from "./validation";
import { ensureWorkspace } from "./workspace";

const folderSchema = z.object({ name: z.string().trim().min(1).max(80) });
const idParams = z.object({ id: z.uuid() });

/** Folders in the caller's personal workspace (team workspaces come later). */
export function registerFolderRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const workspaceOf = (user: ReturnType<typeof requireUser>) =>
    deps.db.transaction((tx) => ensureWorkspace(tx, user));

  app.get("/folders", async (request) => {
    const orgId = await workspaceOf(requireUser(request));
    const rows = await deps.db
      .select({ id: folders.id, name: folders.name })
      .from(folders)
      .where(eq(folders.orgId, orgId))
      .orderBy(asc(folders.name));
    return { folders: rows };
  });

  app.post("/folders", async (request, reply) => {
    const user = requireUser(request);
    const { name } = parse(folderSchema, request.body);
    const orgId = await workspaceOf(user);
    const [folder] = await deps.db
      .insert(folders)
      .values({ orgId, name, createdBy: user.id })
      .returning({ id: folders.id, name: folders.name });
    return reply.status(201).send(folder);
  });

  app.patch("/folders/:id", async (request) => {
    const user = requireUser(request);
    const { id } = parse(idParams, request.params);
    const { name } = parse(folderSchema, request.body);
    const orgId = await workspaceOf(user);
    const [folder] = await deps.db
      .update(folders)
      .set({ name })
      .where(and(eq(folders.id, id), eq(folders.orgId, orgId)))
      .returning({ id: folders.id, name: folders.name });
    if (!folder) throw new NotFoundError("Folder not found");
    return folder;
  });

  /** Boards in the folder are kept (moved out of it), never deleted. */
  app.delete("/folders/:id", async (request, reply) => {
    const user = requireUser(request);
    const { id } = parse(idParams, request.params);
    const orgId = await workspaceOf(user);
    const removed = await deps.db
      .delete(folders)
      .where(and(eq(folders.id, id), eq(folders.orgId, orgId)))
      .returning({ id: folders.id });
    if (removed.length === 0) throw new NotFoundError("Folder not found");
    return reply.status(204).send();
  });
}
