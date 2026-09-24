import { describe, expect, it } from "vitest";
import { EnvValidationError, loadEnv } from "../src/env";
import { serverEnvSchema } from "../src/env/server";
import { webEnvSchema } from "../src/env/web";

const validServerEnv = {
  DATABASE_URL: "postgresql://postgres:s3cret-password@127.0.0.1:54322/postgres",
  REDIS_URL: "redis://127.0.0.1:6379",
  CORS_ALLOWED_ORIGINS: "http://localhost:5173, https://app.example.com/",
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
      "CORS_ALLOWED_ORIGINS",
      "DATABASE_URL",
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

  it("requires Redis in production", () => {
    const error = captureError(() =>
      loadEnv(serverEnvSchema, { ...validServerEnv, REDIS_URL: "", NODE_ENV: "production" }),
    );
    expect(error.issues).toEqual([{ variable: "REDIS_URL", problem: "is required in production" }]);
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

describe("loadEnv(webEnvSchema)", () => {
  it("strips a trailing slash from the API URL", () => {
    expect(loadEnv(webEnvSchema, { VITE_API_URL: "http://localhost:4000/" }).VITE_API_URL).toBe(
      "http://localhost:4000",
    );
  });

  it("fails when VITE_API_URL is missing", () => {
    const error = captureError(() => loadEnv(webEnvSchema, { MODE: "production" }));
    expect(error.issues).toEqual([{ variable: "VITE_API_URL", problem: "is required" }]);
  });
});
