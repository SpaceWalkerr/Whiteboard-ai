import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "@whiteboard/shared/db";
import type { App } from "../src/app";
import { TicketIssuer } from "../src/auth/tickets";
import { MemoryMailer } from "../src/email/mailer";
import { API_SECURITY_HEADERS } from "../src/http/securityHeaders";
import { LocalRevocationBus } from "../src/revocation/bus";
import { silentLogger, testApp } from "./helpers";

/**
 * Cross-cutting HTTP protections, checked against the full route table rather than one route
 * at a time, so a route added later can't silently miss them. No database: every request
 * here is refused before route code would query it.
 */

const TOKEN = "valid-test-token";
const USER = {
  id: "00000000-0000-4000-8000-000000000001",
  email: null,
  name: null,
  avatarUrl: null,
};

interface RouteEntry {
  method: string;
  url: string;
}

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function apiApp(): Promise<{ app: App; routes: RouteEntry[] }> {
  // Never called: the protections under test answer before any handler runs.
  const db = new Proxy({} as Database, {
    get() {
      throw new Error("database used in a test that must not reach route code");
    },
  });
  const built = testApp({
    api: {
      db,
      verifier: {
        verify: (token) =>
          token === TOKEN ? Promise.resolve(USER) : Promise.reject(new Error("bad token")),
      },
      tickets: new TicketIssuer("t".repeat(32)),
      mailer: new MemoryMailer(),
      revocations: new LocalRevocationBus(),
      logger: silentLogger,
      appUrl: "http://app.test",
      cronSecret: "c".repeat(32),
    },
  });
  const routes: RouteEntry[] = [];
  built.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) if (method !== "HEAD") routes.push({ method, url: route.url });
  });
  await built.ready();
  app = built;
  return { app: built, routes };
}

/** A concrete URL for a route pattern (`:id` → a uuid). */
function concrete(url: string): string {
  return url.replace(/:[A-Za-z]+/g, "00000000-0000-4000-8000-000000000002");
}

const SESSIONLESS = ["/healthz", "/readyz", "/metrics"];
const isMutating = (method: string) => ["POST", "PUT", "PATCH", "DELETE"].includes(method);

describe("security headers", () => {
  it("are on every kind of response: health, API errors, 404s", async () => {
    const { app } = await apiApp();
    for (const url of ["/healthz", "/boards", "/no-such-route"]) {
      const res = await app.inject({ method: "GET", url });
      for (const [name, value] of Object.entries(API_SECURITY_HEADERS))
        expect(res.headers[name.toLowerCase()], `${name} on ${url}`).toBe(value);
      expect(res.headers["cache-control"]).toBe("no-store");
    }
  });
});

describe("CSRF", () => {
  it("refuses form and text/plain bodies on every mutating API route (no preflight-free writes)", async () => {
    const { app, routes } = await apiApp();
    const mutating = routes.filter(
      (route) => isMutating(route.method) && !route.url.startsWith("/internal/"),
    );
    expect(mutating.length).toBeGreaterThan(40);
    for (const route of mutating) {
      // The webhook reads raw JSON bytes and is authenticated by its signature, not a session.
      if (route.url === "/billing/webhooks/razorpay") continue;
      for (const contentType of [
        "text/plain",
        "application/x-www-form-urlencoded",
        "multipart/form-data; boundary=x",
      ]) {
        const res = await app.inject({
          method: route.method as "POST",
          url: concrete(route.url),
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": contentType },
          payload: "a=1",
        });
        expect(res.statusCode, `${route.method} ${route.url} with ${contentType}`).toBe(415);
      }
    }
  });

  it("never allows credentialed cross-origin requests", async () => {
    const { app } = await apiApp();
    const res = await app.inject({
      method: "OPTIONS",
      url: "/boards",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });
});

describe("request size", () => {
  it("refuses JSON bodies over 256 kB with 413 before route code runs", async () => {
    const { app } = await apiApp();
    const res = await app.inject({
      method: "POST",
      url: "/boards",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      payload: JSON.stringify({ title: "x".repeat(300 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
  });
});

describe("rate limits", () => {
  it("cover every API route, signed out, per client", async () => {
    const { app, routes } = await apiApp();
    // Use up the anonymous budget of one IP on one route…
    for (let i = 0; i < 300; i++) {
      const res = await app.inject({ method: "GET", url: "/boards", remoteAddress: "10.1.1.1" });
      expect(res.statusCode).toBe(401);
    }
    // …then every other session route answers 429 for that IP: at once (the shared budget),
    // or within its own, stricter per-route budget (tickets, invites, AI, checkout…).
    const unlimited: string[] = [];
    for (const route of routes) {
      if (route.method === "OPTIONS") continue; // CORS preflight, answered by the CORS plugin
      if (SESSIONLESS.includes(route.url) || route.url.startsWith("/internal/")) continue;
      if (route.url === "/billing/webhooks/razorpay") continue;
      let status = 0;
      for (let i = 0; i < 61 && status !== 429; i++) {
        const res = await app.inject({
          method: route.method as "GET",
          url: concrete(route.url),
          remoteAddress: "10.1.1.1",
        });
        status = res.statusCode;
      }
      if (status !== 429) unlimited.push(`${route.method} ${route.url}`);
    }
    expect(unlimited).toEqual([]);
    // Another client is unaffected.
    const other = await app.inject({ method: "GET", url: "/boards", remoteAddress: "10.2.2.2" });
    expect(other.statusCode).toBe(401);
  });

  it("limit the cron endpoints per IP, so the secret can't be brute-forced", async () => {
    const { app } = await apiApp();
    const statuses = new Set<number>();
    for (let i = 0; i < 31; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/internal/purge-trash",
        headers: { authorization: `Bearer ${"x".repeat(32)}` },
        remoteAddress: "10.3.3.3",
      });
      statuses.add(res.statusCode);
    }
    expect([...statuses]).toEqual([401, 429]);
  });

  it("limit the payment webhook per IP", async () => {
    const { app } = await apiApp();
    let last = 0;
    for (let i = 0; i < 601; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/billing/webhooks/razorpay",
        headers: { "content-type": "application/json" },
        payload: "{}",
        remoteAddress: "10.4.4.4",
      });
      last = res.statusCode;
    }
    expect(last).toBe(429);
  });

  it("don't apply to health checks", async () => {
    const { app } = await apiApp();
    for (let i = 0; i < 400; i++) {
      const res = await app.inject({ method: "GET", url: "/healthz", remoteAddress: "10.5.5.5" });
      expect(res.statusCode).toBe(200);
    }
  });
});

describe("logs", () => {
  it("redact bearer tokens, cookies and share-link tokens", async () => {
    const { pino } = await import("pino");
    const { REDACT_PATHS } = await import("../src/logger");
    const lines: string[] = [];
    const logger = pino(
      { redact: { paths: REDACT_PATHS, censor: "[redacted]" } },
      { write: (line: string) => lines.push(line) },
    );
    logger.info(
      {
        req: {
          headers: {
            authorization: "Bearer secret-jwt",
            cookie: "a=secret-cookie",
            "x-share-token": "secret-share-token",
          },
        },
      },
      "request",
    );
    expect(lines.join("")).not.toMatch(/secret-/);
  });
});
