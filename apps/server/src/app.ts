import { randomUUID, timingSafeEqual } from "node:crypto";
import cors from "@fastify/cors";
import Fastify, { LogController } from "fastify";
import type { Registry } from "prom-client";
import type { Logger } from "pino";
import type { HealthResponse } from "@whiteboard/shared/schemas";
import { AppError, type ErrorBody } from "./errors";
import { runReadinessChecks, type DependencyCheck } from "./http/readiness";

export interface AppOptions {
  logger: Logger;
  isAllowedOrigin: (origin: string) => boolean;
  readinessChecks: readonly DependencyCheck[];
  /** Per-dependency timeout for /readyz. Kept short so health checks answer quickly. */
  readinessTimeoutMs?: number;
  /** Prometheus registry served at /metrics; `token` (when set) is required as a bearer token. */
  metrics?: { registry: Registry; token: string | undefined };
}

export function buildApp(options: AppOptions) {
  const app = Fastify({
    loggerInstance: options.logger,
    genReqId: () => randomUUID(),
    logController: new LogController({
      // Health probes hit these every few seconds; logging them would drown real traffic.
      disableRequestLogging: (request) =>
        request.url === "/healthz" || request.url === "/readyz" || request.url === "/metrics",
    }),
  });

  void app.register(cors, {
    // Requests without an Origin header (curl, server-to-server) don't need CORS headers.
    // CORS is not authentication: every route still checks the bearer token itself.
    origin: (origin, callback) => {
      callback(null, origin === undefined || options.isAllowedOrigin(origin));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Authorization", "Content-Type"],
    credentials: false,
    maxAge: 600,
  });

  app.setErrorHandler<Error & { statusCode?: number; code?: string }>((error, request, reply) => {
    if (error instanceof AppError) {
      request.log.warn({ err: error }, "request failed");
      return reply.status(error.statusCode).send(errorBody(error.code, error.message));
    }
    // Fastify's own client errors (malformed JSON, body too large, ...) have safe messages.
    if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
      return reply
        .status(error.statusCode)
        .send(errorBody(error.code ?? "BAD_REQUEST", error.message));
    }
    request.log.error({ err: error }, "unhandled error");
    return reply.status(500).send(errorBody("INTERNAL_ERROR", "Something went wrong"));
  });

  app.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send(errorBody("NOT_FOUND", "Not found"));
  });

  // Liveness: the process is up and the event loop answers. Never checks dependencies,
  // otherwise a Redis blip would get every instance restarted at once.
  app.get("/healthz", (): HealthResponse => ({ status: "ok" }));

  // Readiness: this instance can serve traffic (Postgres and Redis reachable).
  app.get("/readyz", async (request, reply) => {
    const { body, failures } = await runReadinessChecks(
      options.readinessChecks,
      options.readinessTimeoutMs ?? 1000,
    );
    for (const { name, error } of failures) {
      request.log.warn({ err: error, dependency: name }, "readiness check failed");
    }
    return reply.status(body.status === "ready" ? 200 : 503).send(body);
  });

  const metrics = options.metrics;
  if (metrics) {
    app.get("/metrics", async (request, reply) => {
      if (
        metrics.token !== undefined &&
        !bearerMatches(request.headers.authorization, metrics.token)
      ) {
        throw new AppError(401, "UNAUTHORIZED", "A valid metrics token is required");
      }
      return reply.type(metrics.registry.contentType).send(await metrics.registry.metrics());
    });
  }

  return app;
}

/** Constant-time comparison so the token can't be guessed byte by byte from timings. */
function bearerMatches(header: string | undefined, token: string): boolean {
  const provided = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export type App = ReturnType<typeof buildApp>;

function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}
