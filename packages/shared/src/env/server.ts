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
     * Postgres connections per instance. Supabase's session pooler caps connections per
     * project (15 on small computes), so instances × DATABASE_POOL_MAX (plus migrations and
     * cron) must stay below that. Half of the pool at most is used for persistence writes.
     */
    DATABASE_POOL_MAX: z.coerce.number().int().min(2).max(100).default(10),
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

    /** Longest an incoming update waits before it is written to the database (batching window). */
    SYNC_FLUSH_MS: z.coerce.number().int().min(1).max(1000).default(50),
    /** Fold a board's update log into a snapshot after this many updates. */
    SNAPSHOT_EVERY_UPDATES: z.coerce.number().int().min(10).max(100_000).default(500),

    /** Supabase project URL; the JWKS used to verify access tokens is derived from it. */
    SUPABASE_URL: z.url().transform((value) => value.replace(/\/$/, "")),
    /** Service-role key: Storage access (thumbnails). Server-only. Required in production. */
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
    /** HMAC secret for 5-minute WebSocket room tickets (at least 32 characters). */
    ROOM_TICKET_SECRET: z.string().min(32, { message: "must be at least 32 characters" }),
    /** Public URL of the web app, for links in emails. */
    APP_URL: z.url().transform((value) => value.replace(/\/$/, "")),
    /** "log" prints emails to the server log (development); "resend" sends them. */
    EMAIL_TRANSPORT: z.enum(["log", "resend"]).default("log"),
    RESEND_API_KEY: z.string().min(10).optional(),
    EMAIL_FROM: z.string().min(3).optional(),
    /** Bearer secret for internal cron endpoints (trash purge). Required in production. */
    CRON_SECRET: z.string().min(32, { message: "must be at least 32 characters" }).optional(),
    /** Trust X-Forwarded-For from this many proxy hops (1 on Render) so rate limits see real IPs. */
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),

    /** Bearer token for GET /metrics. Optional in development, required in production. */
    METRICS_TOKEN: z.string().min(32, { message: "must be at least 32 characters" }).optional(),

    /**
     * Names this instance in logs, Redis messages and persistence leases (a random suffix
     * is added per process). Defaults to Render's RENDER_INSTANCE_ID.
     */
    INSTANCE_ID: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,64}$/)
      .optional(),
    /** Set by Render on every instance. */
    RENDER_INSTANCE_ID: z.string().min(1).max(64).optional(),
    /**
     * Room persistence lease TTL (Redis, multi-instance). If the writing instance dies,
     * another one takes over within this time; renewed every third of it.
     */
    SYNC_LEASE_TTL_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
    /** How often each room re-checks with the other instances for missed updates. */
    SYNC_RESYNC_MS: z.coerce.number().int().min(1_000).max(600_000).default(15_000),

    /** Hard deadline for graceful shutdown; must stay below Render's shutdown window. */
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(290_000).default(25_000),
  })
  .superRefine((env, ctx) => {
    const require = (key: keyof typeof env, when: boolean, message: string) => {
      if (when && env[key] === undefined) ctx.addIssue({ code: "custom", path: [key], message });
    };
    const production = env.NODE_ENV === "production";
    require("REDIS_URL", production, "is required in production");
    require("METRICS_TOKEN", production, "is required in production");
    require("SUPABASE_SERVICE_ROLE_KEY", production, "is required in production");
    require("CRON_SECRET", production, "is required in production");
    if (production && env.EMAIL_TRANSPORT !== "resend") {
      ctx.addIssue({
        code: "custom",
        path: ["EMAIL_TRANSPORT"],
        message: 'must be "resend" in production',
      });
    }
    const resend = env.EMAIL_TRANSPORT === "resend";
    require("RESEND_API_KEY", resend, "is required when EMAIL_TRANSPORT=resend");
    require("EMAIL_FROM", resend, "is required when EMAIL_TRANSPORT=resend");
  });

export type ServerEnv = z.output<typeof serverEnvSchema>;
