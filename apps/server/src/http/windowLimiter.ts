import type { Redis } from "ioredis";

/**
 * Fixed-window counter: at most `max` hits per key per `windowMs`. Shared across instances
 * through Redis when configured; per process otherwise (single-instance development).
 * Used where @fastify/rate-limit can't reach, such as WebSocket upgrades.
 */
export interface WindowLimiter {
  /** Counts a hit; false when the key is over its limit for the current window. */
  hit(key: string): Promise<boolean>;
}

export interface WindowLimiterOptions {
  max: number;
  windowMs: number;
  /** Redis key prefix, e.g. "whiteboard:ws-upgrade:". */
  prefix: string;
  redis?: Redis | undefined;
  now?: () => number;
}

// INCR and set the expiry on the first hit, atomically (no key can be left without a TTL).
const INCR_WITH_TTL = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then redis.call("PEXPIRE", KEYS[1], ARGV[1]) end
return count`;

export function createWindowLimiter(options: WindowLimiterOptions): WindowLimiter {
  const { max, windowMs, prefix, redis } = options;
  const now = options.now ?? Date.now;
  if (redis) {
    return {
      async hit(key) {
        const window = Math.floor(now() / windowMs);
        try {
          const count = await redis.eval(
            INCR_WITH_TTL,
            1,
            `${prefix}${key}:${String(window)}`,
            String(windowMs),
          );
          return Number(count) <= max;
        } catch {
          // Fail open: a Redis blip must not lock everyone out of their boards. Per-message
          // limits on each socket still apply.
          return true;
        }
      },
    };
  }

  const counts = new Map<string, { window: number; count: number }>();
  return {
    hit(key) {
      const window = Math.floor(now() / windowMs);
      // Forget finished windows so the map can't grow without bound.
      if (counts.size > 10_000) {
        for (const [k, v] of counts) if (v.window !== window) counts.delete(k);
      }
      const entry = counts.get(key);
      const count = entry?.window === window ? entry.count + 1 : 1;
      counts.set(key, { window, count });
      return Promise.resolve(count <= max);
    },
  };
}
