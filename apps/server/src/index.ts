import { EnvValidationError, loadEnv } from "@whiteboard/shared/env";
import { serverEnvSchema, type ServerEnv } from "@whiteboard/shared/env/server";
import { createDb } from "@whiteboard/shared/db";
import { PgBoardRepository } from "./persistence/pgRepository";
import { buildApp } from "./app";
import { createOriginMatcher } from "./http/origins";
import { closeRedis, createRedis } from "./infra/redis";
import { createLogger } from "./logger";
import { createShutdown } from "./shutdown";
import { LocalRevocationBus, RedisRevocationBus } from "./revocation/bus";
import { TicketIssuer } from "./auth/tickets";
import { createTokenVerifier, supabaseJwks } from "./auth/verifier";
import { LogMailer, ResendMailer } from "./email/mailer";
import { SupabaseThumbnailStorage } from "./storage/thumbnails";
import { ticketAuthorizer } from "./sync/ticketAuth";
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

  const tickets = new TicketIssuer(env.ROOM_TICKET_SECRET);
  const revocations = redis ? new RedisRevocationBus(redis, logger) : new LocalRevocationBus();
  const mailer =
    env.EMAIL_TRANSPORT === "resend" && env.RESEND_API_KEY && env.EMAIL_FROM
      ? new ResendMailer(env.RESEND_API_KEY, env.EMAIL_FROM)
      : new LogMailer(logger);

  const repository = new PgBoardRepository(db);
  const thumbnails = env.SUPABASE_SERVICE_ROLE_KEY
    ? new SupabaseThumbnailStorage(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
    : undefined;
  if (!thumbnails) logger.warn("SUPABASE_SERVICE_ROLE_KEY not set; board thumbnails are disabled");

  const metrics = createSyncMetrics();
  const app = buildApp({
    logger,
    isAllowedOrigin,
    readinessChecks: [
      { name: "postgres", check: () => sql`select 1` },
      ...(redis ? [{ name: "redis", check: () => redis.ping() }] : []),
    ],
    metrics: { registry: metrics.registry, token: env.METRICS_TOKEN },
    trustProxy: env.TRUST_PROXY,
    api: {
      db,
      verifier: createTokenVerifier({
        issuer: `${env.SUPABASE_URL}/auth/v1`,
        keys: supabaseJwks(env.SUPABASE_URL),
      }),
      tickets,
      mailer,
      revocations,
      logger,
      appUrl: env.APP_URL,
      redis,
      thumbnails,
      boardStore: repository,
      cronSecret: env.CRON_SECRET,
    },
  });
  const sync = attachSyncServer(app.server, {
    isAllowedOrigin,
    // Room ticket from the REST API, re-checked against the database on every upgrade.
    authorize: ticketAuthorizer(tickets, db),
    revocations,
    logger,
    metrics,
    roomGraceMs: env.SYNC_ROOM_GRACE_MS,
    rateLimit: {
      perSecond: env.SYNC_RATE_LIMIT_PER_SEC,
      burst: env.SYNC_RATE_LIMIT_BURST,
      bytesPerSecond: env.SYNC_BYTES_PER_SEC,
      bytesBurst: env.SYNC_BYTES_BURST,
    },
    repository,
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
      { name: "revocations", run: () => revocations.close() },
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
