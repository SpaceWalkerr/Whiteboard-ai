import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import { registerBoardExtraRoutes } from "./boardExtras";
import { registerBoardRoutes } from "./boards";
import { registerFolderRoutes } from "./folders";
export { registerInternalRoutes } from "./internal";
import type { ApiDeps } from "./deps";
import { registerMeRoutes } from "./me";
import { registerReviewRoutes } from "./reviews";
import { registerSharingRoutes } from "./sharing";

/**
 * The authenticated REST API. Rate limits apply per signed-in user (or per IP when signed
 * out), shared across instances through Redis when configured; stricter limits are set on
 * ticket, invite and bootstrap routes.
 */
export async function registerApi(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    hook: "preHandler",
    keyGenerator: (request) => request.user?.id ?? request.ip,
    ...(deps.redis ? { redis: deps.redis, nameSpace: "whiteboard:rate:", skipOnError: true } : {}),
  });
  registerMeRoutes(app, deps);
  registerBoardRoutes(app, deps);
  registerSharingRoutes(app, deps);
  registerFolderRoutes(app, deps);
  registerBoardExtraRoutes(app, deps);
  registerReviewRoutes(app, deps);
}
