import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLUSTER_KINDS, decodeClusterMessage, encodeClusterMessage } from "../src/cluster/envelope";
import { leaseKey, RedisLease } from "../src/cluster/lease";
import { connectTestRedis } from "./clusterHelpers";

describe("cluster message envelope", () => {
  it("round-trips every kind", () => {
    for (const kind of Object.values(CLUSTER_KINDS)) {
      const message = {
        from: "instance-a",
        kind,
        payload: new Uint8Array([1, 2, 3]),
        to: kind === CLUSTER_KINDS.syncReply ? "instance-b" : null,
      };
      expect(decodeClusterMessage(encodeClusterMessage(message))).toEqual(message);
    }
  });

  it("rejects malformed input", () => {
    const valid = encodeClusterMessage({
      from: "a",
      kind: CLUSTER_KINDS.update,
      payload: new Uint8Array([9]),
      to: null,
    });
    expect(decodeClusterMessage(new Uint8Array())).toBeNull();
    expect(decodeClusterMessage(valid.slice(0, -1))).toBeNull(); // truncated
    expect(decodeClusterMessage(new Uint8Array([...valid, 0]))).toBeNull(); // trailing bytes
    expect(decodeClusterMessage(new Uint8Array([2, ...valid.slice(1)]))).toBeNull(); // version
    const badKind = encodeClusterMessage({
      from: "a",
      kind: CLUSTER_KINDS.update,
      payload: new Uint8Array(),
      to: null,
    });
    badKind[3] = 99; // kind byte ("a" is 1 length byte + 1 char after the version)
    expect(decodeClusterMessage(badKind)).toBeNull();
    const noSender = encodeClusterMessage({
      from: "",
      kind: CLUSTER_KINDS.update,
      payload: new Uint8Array(),
      to: null,
    });
    expect(decodeClusterMessage(noSender)).toBeNull();
  });
});

describe("persistence lease (Redis)", () => {
  let redis: Redis;
  beforeAll(async () => {
    redis = await connectTestRedis();
  });
  afterAll(() => {
    redis.disconnect();
  });

  it("is held by one instance at a time", async () => {
    const board = crypto.randomUUID();
    const a = new RedisLease(redis, "a", 5_000);
    const b = new RedisLease(redis, "b", 5_000);
    expect(await a.acquire(board)).toBe(true);
    expect(await a.acquire(board)).toBe(true); // re-acquiring our own lease renews it
    expect(await b.acquire(board)).toBe(false);
    expect(await b.renew(board)).toBe(false);
    // Only the holder can release it.
    await b.release(board);
    expect(await redis.get(leaseKey(board))).toBe("a");
    await a.release(board);
    expect(await b.acquire(board)).toBe(true);
    await b.release(board);
  });

  it("expires when the holder stops renewing (it died)", async () => {
    const board = crypto.randomUUID();
    const dead = new RedisLease(redis, "dead", 200);
    const survivor = new RedisLease(redis, "survivor", 5_000);
    expect(await dead.acquire(board)).toBe(true);
    expect(await survivor.acquire(board)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await survivor.acquire(board)).toBe(true);
    // The old holder can't extend what is no longer its lease.
    expect(await dead.renew(board)).toBe(false);
    await survivor.release(board);
  });

  it("renewal keeps a lease alive past its TTL", async () => {
    const board = crypto.randomUUID();
    const holder = new RedisLease(redis, "holder", 300);
    const other = new RedisLease(redis, "other", 300);
    expect(await holder.acquire(board)).toBe(true);
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(await holder.renew(board)).toBe(true);
    }
    expect(await other.acquire(board)).toBe(false);
    await holder.release(board);
  });
});
