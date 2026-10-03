import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, { LogController } from "fastify";
import type { Registry } from "prom-client";
import type { Logger } from "pino";
import type { HealthResponse } from "@whiteboard/shared/schemas";
import { AppError, type ErrorBody } from "./errors";
import { runReadinessChecks, type DependencyCheck } from "./http/readiness";
import { registerApi, registerBillingWebhook, registerInternalRoutes } from "./api";
import type { ApiDeps } from "./api/deps";
import { registerRequestAuth } from "./auth/requestAuth";
import { bearerMatches } from "./http/bearer";
import { API_SECURITY_HEADERS } from "./http/securityHeaders";

/**
 * Largest request body accepted anywhere unless a route sets its own (thumbnails, AI review of
 * a private board's graph). Everything else is small JSON; a lower cap limits memory abuse.
 */
export const DEFAULT_BODY_LIMIT = 256 * 1024;

export interface AppOptions {
  logger: Logger;
  isAllowedOrigin: (origin: string) => boolean;
  readinessChecks: readonly DependencyCheck[];
  /** Per-dependency timeout for /readyz. Kept short so health checks answer quickly. */
  readinessTimeoutMs?: number;
  /** Prometheus registry served at /metrics; `token` (when set) is required as a bearer token. */
  metrics?: { registry: Registry; token: string | undefined };
  /** The authenticated REST API (omitted in tests that only exercise health and sync). */
  api?: ApiDeps | undefined;
  /** Trust X-Forwarded-For from this many proxy hops (the load balancer on Render). */
  trustProxy?: number | undefined;
}

export function buildApp(options: AppOptions) {
  const app = Fastify({
    loggerInstance: options.logger,
    // Trust only the configured number of proxy hops (Render's load balancer), so clients
    // can't spoof their IP for rate limiting via X-Forwarded-For.
    trustProxy:
      (options.trustProxy ?? 0) > 0
        ? (_address: string, hop: number) => hop < (options.trustProxy ?? 0)
        : false,
    genReqId: () => randomUUID(),
    bodyLimit: DEFAULT_BODY_LIMIT,
    logController: new LogController({
      // Health probes hit these every few seconds; logging them would drown real traffic.
      disableRequestLogging: (request) =>
        request.url === "/healthz" || request.url === "/readyz" || request.url === "/metrics",
    }),
  });

  // Set on request, so streams that write the raw response (review progress) carry them too.
  app.addHook("onRequest", async (_request, reply) => {
    reply.headers(API_SECURITY_HEADERS);
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    if (!reply.hasHeader("cache-control")) reply.header("Cache-Control", "no-store");
    return payload;
  });

  void app.register(cors, {
    // Requests without an Origin header (curl, server-to-server) don't need CORS headers.
    // CORS is not authentication: every route still checks the bearer token itself.
    origin: (origin, callback) => {
      callback(null, origin === undefined || options.isAllowedOrigin(origin));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Share-Token"],
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

  // Readiness: this instance can serve traffic (Postgres and Redis reachable). Unauthenticated
  // and public, so concurrent probes share one run of the checks: a flood of /readyz requests
  // can't turn into a flood of database queries.
  let readiness: ReturnType<typeof runReadinessChecks> | null = null;
  app.get("/readyz", async (request, reply) => {
    readiness ??= runReadinessChecks(
      options.readinessChecks,
      options.readinessTimeoutMs ?? 1000,
    ).finally(() => {
      readiness = null;
    });
    const { body, failures } = await readiness;
    for (const { name, error } of failures) {
      request.log.warn({ err: error, dependency: name }, "readiness check failed");
    }
    return reply.status(body.status === "ready" ? 200 : 503).send(body);
  });

  const api = options.api;
  if (api) {
    // The API lives in its own scope: session verification (request.user) and rate limits
    // apply to API routes only, never to health checks or metrics.
    void app.register(async (scope) => {
      // CSRF defence in depth. The API authenticates with a bearer token, never a cookie, so a
      // cross-site form or no-cors fetch carries no credentials. On top of that, only the
      // content types a cross-site request can't send without a CORS preflight are parsed:
      // text/plain (Fastify's default) is removed, and url-encoded/multipart forms have no
      // parser, so such requests get 415 before any route code runs.
      scope.removeContentTypeParser("text/plain");
      registerRequestAuth(scope, api.verifier);
      await registerApi(scope, api);
    });
    // Scheduled-job endpoints: CRON_SECRET only, no user session. Rate limited per IP so the
    // secret can't be brute-forced and a leaked one can't be used to hammer the database.
    void app.register(async (scope) => {
      await scope.register(rateLimit, publicRateLimit(api, 30, "whiteboard:rate:internal:"));
      registerInternalRoutes(scope, api);
    });
    // Payment provider webhooks: signature only, raw body, no user session. The limit is far
    // above Razorpay's delivery rate; it stops floods of forged events (each costs an HMAC).
    void app.register(async (scope) => {
      await scope.register(rateLimit, publicRateLimit(api, 600, "whiteboard:rate:webhook:"));
      registerBillingWebhook(scope, api);
    });
  }

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

/** Per-IP limit for routes without a user session (shared across instances via Redis). */
function publicRateLimit(api: ApiDeps, max: number, nameSpace: string) {
  return {
    global: true,
    max,
    timeWindow: "1 minute",
    ...(api.redis ? { redis: api.redis, nameSpace, skipOnError: true } : {}),
  };
}

export type App = ReturnType<typeof buildApp>;

function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}
