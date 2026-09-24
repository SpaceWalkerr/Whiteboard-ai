// Uses the real Redis and Postgres clients pointed at a port where nothing listens, to prove
// /readyz fails fast (no offline queueing, no hang) when a dependency is actually down.
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type SqlClient } from "@whiteboard/shared/db";
import type { Redis } from "ioredis";
import { closeRedis, createRedis } from "../src/infra/redis";
import { silentLogger, testApp } from "./helpers";

let closedPort: number;
let redis: Redis;
let sql: SqlClient;

beforeAll(async () => {
  closedPort = await findClosedPort();
  redis = createRedis(`redis://127.0.0.1:${closedPort}`, silentLogger);
  sql = createDb(`postgresql://postgres:postgres@127.0.0.1:${closedPort}/postgres`, { max: 1 }).sql;
});

afterAll(async () => {
  await closeRedis(redis);
  await sql.end({ timeout: 1 });
});

describe("readiness with unreachable dependencies", () => {
  it("reports 503 within the timeout", async () => {
    const app = testApp({
      readinessTimeoutMs: 1000,
      readinessChecks: [
        { name: "postgres", check: () => sql`select 1` },
        { name: "redis", check: () => redis.ping() },
      ],
    });
    const started = Date.now();
    const res = await app.inject({ method: "GET", url: "/readyz" });
    await app.close();

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: "not_ready",
      checks: { postgres: "down", redis: "down" },
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

/** Binds an ephemeral port, then releases it, so nothing is listening there. */
async function findClosedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}
