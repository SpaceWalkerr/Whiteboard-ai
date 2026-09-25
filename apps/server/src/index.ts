import { EnvValidationError, loadEnv } from "@whiteboard/shared/env";
import { serverEnvSchema, type ServerEnv } from "@whiteboard/shared/env/server";
import { createDb } from "@whiteboard/shared/db";
import { PgBoardRepository } from "./persistence/pgRepository";
import { buildApp } from "./app";
import { createOriginMatcher } from "./http/origins";
import { closeRedis, createRedis } from "./infra/redis";
import { createLogger } from "./logger";
import { createShutdown } from "./shutdown";
import { allowAllConnections } from "./sync/auth";
import { createSyncMetrics } from "./sync/metrics";
import { attachSyncServer } from "./sync/upgrade";

function readEnvOrExit(): ServerEnv {
  try {
    return loadEnv(serverEnvSchema, process.env);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      // The logger isn't configured yet (it depends on env), so write directly.
      process.stderr.write(`[whiteboard-server] Refusing to start. ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const env = readEnvOrExit();
  const logger = createLogger(env);

  const { sql, db } = createDb(env.DATABASE_URL, { applicationName: "whiteboard-server" });
  // Redis is optional outside production for now (the env schema enforces it in production).
  const redis = env.REDIS_URL === undefined ? undefined : createRedis(env.REDIS_URL, logger);
  if (redis === undefined) logger.warn("REDIS_URL not set; running without Redis");
  const isAllowedOrigin = createOriginMatcher({
    allowedOrigins: env.CORS_ALLOWED_ORIGINS,
    allowedOriginPattern: env.CORS_ALLOWED_ORIGIN_PATTERN,
  });

  const metrics = createSyncMetrics();
  const app = buildApp({
    logger,
    isAllowedOrigin,
    readinessChecks: [
      { name: "postgres", check: () => sql`select 1` },
      ...(redis ? [{ name: "redis", check: () => redis.ping() }] : []),
    ],
    metrics: { registry: metrics.registry, token: env.METRICS_TOKEN },
  });
  const sync = attachSyncServer(app.server, {
    isAllowedOrigin,
    // TEMPORARY: Phase 4 replaces this with Supabase JWT verification + board role lookup.
    authorize: allowAllConnections,
    logger,
    metrics,
    roomGraceMs: env.SYNC_ROOM_GRACE_MS,
    rateLimit: {
      perSecond: env.SYNC_RATE_LIMIT_PER_SEC,
      burst: env.SYNC_RATE_LIMIT_BURST,
      bytesPerSecond: env.SYNC_BYTES_PER_SEC,
      bytesBurst: env.SYNC_BYTES_BURST,
    },
    repository: new PgBoardRepository(db),
    flushMs: env.SYNC_FLUSH_MS,
    snapshotEvery: env.SNAPSHOT_EVERY_UPDATES,
  });

  const shutdown = createShutdown({
    logger,
    timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    steps: [
      // Flush + snapshot every room first (needs the database), leaving a few seconds of the
      // shutdown budget for closing HTTP, Redis and Postgres.
      {
        name: "sync",
        run: () => sync.close(Date.now() + Math.max(1_000, env.SHUTDOWN_TIMEOUT_MS - 5_000)),
      },
      { name: "http", run: () => app.close() },
      ...(redis ? [{ name: "redis", run: () => closeRedis(redis) }] : []),
      { name: "postgres", run: () => sql.end({ timeout: 5 }) },
    ],
  });

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "unhandled promise rejection");
    void shutdown("unhandledRejection", 1);
  });
  process.on("uncaughtException", (error) => {
    logger.fatal({ err: error }, "uncaught exception");
    void shutdown("uncaughtException", 1);
  });

  await app.listen({ host: env.HOST, port: env.PORT });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[whiteboard-server] Failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
