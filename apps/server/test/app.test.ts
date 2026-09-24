import { afterEach, describe, expect, it } from "vitest";
import { healthResponseSchema, readinessResponseSchema } from "@whiteboard/shared/schemas";
import type { App } from "../src/app";
import { NotFoundError } from "../src/errors";
import { testApp } from "./helpers";

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const up = () => Promise.resolve();
const down = () => Promise.reject(new Error("ECONNREFUSED"));

describe("GET /healthz", () => {
  it("returns 200 without touching dependencies", async () => {
    app = testApp({ readinessChecks: [{ name: "redis", check: down }] });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(healthResponseSchema.parse(res.json())).toEqual({ status: "ok" });
  });
});

describe("GET /readyz", () => {
  it("returns 200 when every dependency is up", async () => {
    app = testApp({
      readinessChecks: [
        { name: "postgres", check: up },
        { name: "redis", check: up },
      ],
    });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(readinessResponseSchema.parse(res.json())).toEqual({
      status: "ready",
      checks: { postgres: "up", redis: "up" },
    });
  });

  it("returns 503 and names the failing dependency when Redis is down", async () => {
    app = testApp({
      readinessChecks: [
        { name: "postgres", check: up },
        { name: "redis", check: down },
      ],
    });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "not_ready", checks: { postgres: "up", redis: "down" } });
  });

  it("returns 503 when Postgres is down", async () => {
    app = testApp({
      readinessChecks: [
        { name: "postgres", check: down },
        { name: "redis", check: up },
      ],
    });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ checks: { postgres: "down" } });
  });

  it("treats a hung dependency as down after the timeout", async () => {
    app = testApp({
      readinessTimeoutMs: 50,
      readinessChecks: [{ name: "postgres", check: () => new Promise(() => undefined) }],
    });
    const started = Date.now();
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("CORS", () => {
  it("allows an exact allowlisted origin", async () => {
    app = testApp();
    const res = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: "http://localhost:5173" },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("allows an origin matching the preview pattern", async () => {
    app = testApp();
    const origin = "https://whiteboard-ai-git-feature-x.vercel.app";
    const res = await app.inject({
      method: "OPTIONS",
      url: "/healthz",
      headers: { origin, "access-control-request-method": "GET" },
    });
    expect(res.headers["access-control-allow-origin"]).toBe(origin);
  });

  it.each(["https://evil.example.com", "https://whiteboard-ai-x.vercel.app.evil.com"])(
    "does not grant CORS to %s",
    async (origin) => {
      app = testApp();
      const res = await app.inject({ method: "GET", url: "/healthz", headers: { origin } });
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    },
  );
});

describe("error handling", () => {
  it("returns a JSON 404 for unknown routes", async () => {
    app = testApp();
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } });
  });

  it("returns the public message of an AppError", async () => {
    app = testApp();
    app.get("/missing-thing", () => {
      throw new NotFoundError("Board not found");
    });
    const res = await app.inject({ method: "GET", url: "/missing-thing" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Board not found" } });
  });

  it("hides the details of unexpected errors", async () => {
    app = testApp();
    app.get("/boom", () => {
      throw new Error("password=hunter2 leaked in a driver error");
    });
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("hunter2");
    expect(res.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Something went wrong" },
    });
  });
});
