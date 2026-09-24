import { Redis } from "ioredis";
import type { Logger } from "pino";

const ERROR_LOG_INTERVAL_MS = 10_000;

export function createRedis(url: string, logger: Logger): Redis {
  const redis = new Redis(url, {
    // Fail fast while disconnected instead of queueing commands forever; callers (and
    // /readyz) must see an outage immediately.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    // Keep reconnecting with capped backoff so the instance recovers when Redis returns.
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
    connectionName: "whiteboard-server",
  });

  // ioredis emits an error on every reconnect attempt; throttle so logs stay readable.
  let lastErrorLoggedAt = 0;
  redis.on("error", (error: Error) => {
    const now = Date.now();
    if (now - lastErrorLoggedAt < ERROR_LOG_INTERVAL_MS) return;
    lastErrorLoggedAt = now;
    logger.warn({ err: { message: error.message, name: error.name } }, "redis connection error");
  });
  redis.on("ready", () => {
    logger.info("redis ready");
  });

  return redis;
}

export async function closeRedis(redis: Redis): Promise<void> {
  try {
    await redis.quit();
  } catch {
    // quit() fails when the connection is already down; drop it instead.
    redis.disconnect();
  }
}
