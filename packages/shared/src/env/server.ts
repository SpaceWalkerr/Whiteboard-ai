import { z } from "zod";

const originSchema = z.url().refine(
  (value) => {
    const url = new URL(value);
    return url.origin === value.replace(/\/$/, "");
  },
  { message: "must be an origin like https://app.example.com (no path)" },
);

export const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

    DATABASE_URL: z.url().refine((value) => /^postgres(ql)?:\/\//.test(value), {
      message: "must be a postgres:// URL",
    }),
    /**
     * Optional outside production for now (decided in Phase 0: local dev runs without Redis).
     * Production must have it: 2+ instances share state through Redis.
     */
    REDIS_URL: z
      .url()
      .refine((value) => /^rediss?:\/\//.test(value), {
        message: "must be a redis:// or rediss:// URL",
      })
      .optional(),

    /** Comma-separated exact origins allowed by CORS and WebSocket Origin checks. */
    CORS_ALLOWED_ORIGINS: z
      .string()
      .transform((value) =>
        value
          .split(",")
          .map((origin) => origin.trim().replace(/\/$/, ""))
          .filter(Boolean),
      )
      .pipe(z.array(originSchema).min(1, { message: "must list at least one origin" })),
    /**
     * Optional regex for origins that cannot be listed ahead of time (this project's Vercel
     * preview URLs). It is anchored automatically, so it must match the whole origin.
     */
    CORS_ALLOWED_ORIGIN_PATTERN: z
      .string()
      .optional()
      .transform((value, ctx) => {
        if (value === undefined) return undefined;
        try {
          return new RegExp(`^(?:${value})$`);
        } catch {
          ctx.addIssue({ code: "custom", message: "must be a valid regular expression" });
          return z.NEVER;
        }
      }),

    /** How long an empty sync room keeps its document in memory before eviction. */
    SYNC_ROOM_GRACE_MS: z.coerce.number().int().min(0).max(3_600_000).default(30_000),
    /** Per-connection message rate limit (token bucket). */
    SYNC_RATE_LIMIT_PER_SEC: z.coerce.number().int().min(1).max(10_000).default(120),
    SYNC_RATE_LIMIT_BURST: z.coerce.number().int().min(1).max(100_000).default(300),
    /** Per-connection byte budget (token bucket): sustained bytes/second and burst bytes. */
    SYNC_BYTES_PER_SEC: z.coerce
      .number()
      .int()
      .min(1024)
      .default(1024 * 1024),
    SYNC_BYTES_BURST: z.coerce
      .number()
      .int()
      .min(1024)
      .default(16 * 1024 * 1024),

    /** Bearer token for GET /metrics. Optional in development, required in production. */
    METRICS_TOKEN: z.string().min(32, { message: "must be at least 32 characters" }).optional(),

    /** Hard deadline for graceful shutdown; must stay below Render's shutdown window. */
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(290_000).default(25_000),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && env.REDIS_URL === undefined) {
      ctx.addIssue({ code: "custom", path: ["REDIS_URL"], message: "is required in production" });
    }
    if (env.NODE_ENV === "production" && env.METRICS_TOKEN === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["METRICS_TOKEN"],
        message: "is required in production",
      });
    }
  });

export type ServerEnv = z.output<typeof serverEnvSchema>;
