import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWindowLimiter } from "../src/http/windowLimiter";
import { connectTestRedis } from "./clusterHelpers";

let redis: Redis;
beforeAll(async () => {
  redis = await connectTestRedis();
});
afterAll(() => {
  redis.disconnect();
});

describe("window limiter (Redis)", () => {
  it("shares one budget between instances and sets an expiry on every key", async () => {
    const prefix = `whiteboard:test-limit:${crypto.randomUUID()}:`;
    const one = createWindowLimiter({ max: 3, windowMs: 60_000, prefix, redis });
    const two = createWindowLimiter({ max: 3, windowMs: 60_000, prefix, redis });
    const results = [
      await one.hit("1.2.3.4"),
      await two.hit("1.2.3.4"),
      await one.hit("1.2.3.4"),
      await two.hit("1.2.3.4"),
    ];
    expect(results).toEqual([true, true, true, false]);
    const [key] = await redis.keys(`${prefix}*`);
    expect(key).toBeDefined();
    expect(await redis.pttl(key ?? "")).toBeGreaterThan(0);
  });
});
