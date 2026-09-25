import { describe, expect, it } from "vitest";
import { EnvValidationError, loadEnv } from "../src/env";
import { serverEnvSchema } from "../src/env/server";
import { webEnvSchema } from "../src/env/web";

const validServerEnv = {
  DATABASE_URL: "postgresql://postgres:s3cret-password@127.0.0.1:54322/postgres",
  REDIS_URL: "redis://127.0.0.1:6379",
  CORS_ALLOWED_ORIGINS: "http://localhost:5173, https://app.example.com/",
  SUPABASE_URL: "https://project.supabase.co",
  ROOM_TICKET_SECRET: "t".repeat(32),
  APP_URL: "http://localhost:5173",
};

function captureError(fn: () => unknown): EnvValidationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error("expected loadEnv to throw");
}

describe("loadEnv(serverEnvSchema)", () => {
  it("parses a valid environment and applies defaults", () => {
    const env = loadEnv(serverEnvSchema, validServerEnv);
    expect(env.PORT).toBe(4000);
    expect(env.NODE_ENV).toBe("development");
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(["http://localhost:5173", "https://app.example.com"]);
    expect(env.CORS_ALLOWED_ORIGIN_PATTERN).toBeUndefined();
  });

  it("names every missing required variable", () => {
    const error = captureError(() => loadEnv(serverEnvSchema, {}));
    expect(error.issues.map((i) => i.variable).sort()).toEqual([
      "APP_URL",
      "CORS_ALLOWED_ORIGINS",
      "DATABASE_URL",
      "ROOM_TICKET_SECRET",
      "SUPABASE_URL",
    ]);
    expect(error.message).toContain("DATABASE_URL: is required");
  });

  it("treats an empty string as missing", () => {
    const error = captureError(() =>
      loadEnv(serverEnvSchema, { ...validServerEnv, DATABASE_URL: "" }),
    );
    expect(error.issues).toEqual([{ variable: "DATABASE_URL", problem: "is required" }]);
  });

  it("allows running without Redis outside production", () => {
    expect(
      loadEnv(serverEnvSchema, { ...validServerEnv, REDIS_URL: "" }).REDIS_URL,
    ).toBeUndefined();
  });

  const productionEnv = {
    ...validServerEnv,
    NODE_ENV: "production",
    REDIS_URL: "redis://127.0.0.1:6379",
    METRICS_TOKEN: "m".repeat(32),
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key-0123456789",
    CRON_SECRET: "c".repeat(32),
    EMAIL_TRANSPORT: "resend",
    RESEND_API_KEY: "re_0123456789",
    EMAIL_FROM: "Whiteboard <no-reply@example.com>",
  };

  it("accepts a complete production environment", () => {
    expect(loadEnv(serverEnvSchema, productionEnv).NODE_ENV).toBe("production");
  });

  it.each([
    ["REDIS_URL", "is required in production"],
    ["METRICS_TOKEN", "is required in production"],
    ["SUPABASE_SERVICE_ROLE_KEY", "is required in production"],
    ["CRON_SECRET", "is required in production"],
    ["RESEND_API_KEY", "is required when EMAIL_TRANSPORT=resend"],
    ["EMAIL_FROM", "is required when EMAIL_TRANSPORT=resend"],
  ])("requires %s in production", (variable, problem) => {
    const error = captureError(() =>
      loadEnv(serverEnvSchema, { ...productionEnv, [variable]: "" }),
    );
    expect(error.issues).toEqual([{ variable, problem }]);
  });

  it("refuses the log email transport in production", () => {
    const error = captureError(() =>
      loadEnv(serverEnvSchema, { ...productionEnv, EMAIL_TRANSPORT: "log" }),
    );
    expect(error.issues).toEqual([
      { variable: "EMAIL_TRANSPORT", problem: 'must be "resend" in production' },
    ]);
  });

  it("keeps production-only settings optional in development", () => {
    expect(loadEnv(serverEnvSchema, validServerEnv).METRICS_TOKEN).toBeUndefined();
    const short = captureError(() =>
      loadEnv(serverEnvSchema, { ...validServerEnv, METRICS_TOKEN: "short" }),
    );
    expect(short.issues[0]?.variable).toBe("METRICS_TOKEN");
  });

  it("never echoes variable values in the error message", () => {
    const error = captureError(() =>
      loadEnv(serverEnvSchema, { ...validServerEnv, DATABASE_URL: "mysql://root:hunter2@db/app" }),
    );
    expect(error.message).toContain("DATABASE_URL");
    expect(error.message).not.toContain("hunter2");
  });

  it("rejects origins that carry a path", () => {
    const error = captureError(() =>
      loadEnv(serverEnvSchema, { ...validServerEnv, CORS_ALLOWED_ORIGINS: "https://a.com/app" }),
    );
    expect(error.issues[0]?.variable).toMatch(/^CORS_ALLOWED_ORIGINS/);
  });

  it("anchors the origin pattern so it cannot match a suffix", () => {
    const env = loadEnv(serverEnvSchema, {
      ...validServerEnv,
      CORS_ALLOWED_ORIGIN_PATTERN: String.raw`https://whiteboard-ai-[a-z0-9-]+\.vercel\.app`,
    });
    const pattern = env.CORS_ALLOWED_ORIGIN_PATTERN;
    expect(pattern?.test("https://whiteboard-ai-git-feat-x.vercel.app")).toBe(true);
    expect(pattern?.test("https://whiteboard-ai-x.vercel.app.evil.com")).toBe(false);
  });

  it("rejects an invalid origin pattern", () => {
    const error = captureError(() =>
      loadEnv(serverEnvSchema, { ...validServerEnv, CORS_ALLOWED_ORIGIN_PATTERN: "(" }),
    );
    expect(error.issues[0]).toEqual({
      variable: "CORS_ALLOWED_ORIGIN_PATTERN",
      problem: "must be a valid regular expression",
    });
  });
});

const webBase = {
  VITE_API_URL: "http://localhost:4000",
  VITE_WS_URL: "ws://localhost:4000",
  VITE_SUPABASE_URL: "https://project.supabase.co",
  VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_0123456789abcdef",
};

describe("loadEnv(webEnvSchema)", () => {
  it("strips a trailing slash from the API and WebSocket URLs", () => {
    const env = loadEnv(webEnvSchema, {
      ...webBase,
      VITE_API_URL: "http://localhost:4000/",
      VITE_WS_URL: "ws://localhost:4000/",
    });
    expect(env.VITE_API_URL).toBe("http://localhost:4000");
    expect(env.VITE_WS_URL).toBe("ws://localhost:4000");
  });

  it("requires a ws:// or wss:// sync URL", () => {
    const error = captureError(() =>
      loadEnv(webEnvSchema, {
        ...webBase,
        VITE_API_URL: "http://localhost:4000",
        VITE_WS_URL: "http://localhost:4000",
      }),
    );
    expect(error.issues).toEqual([
      { variable: "VITE_WS_URL", problem: "must be a ws:// or wss:// URL" },
    ]);
  });

  it("keeps debug tools off unless explicitly enabled", () => {
    expect(loadEnv(webEnvSchema, webBase).VITE_DEBUG_TOOLS).toBe(false);
    expect(loadEnv(webEnvSchema, { ...webBase, VITE_DEBUG_TOOLS: "true" }).VITE_DEBUG_TOOLS).toBe(
      true,
    );
  });

  it("names every missing public variable", () => {
    const error = captureError(() => loadEnv(webEnvSchema, { MODE: "production" }));
    expect(error.issues.map((i) => i.variable)).toEqual([
      "VITE_API_URL",
      "VITE_WS_URL",
      "VITE_SUPABASE_URL",
      "VITE_SUPABASE_PUBLISHABLE_KEY",
    ]);
  });
});
