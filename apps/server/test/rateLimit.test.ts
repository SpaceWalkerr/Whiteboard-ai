import { describe, expect, it } from "vitest";
import { TokenBucket } from "../src/sync/rateLimit";

describe("TokenBucket", () => {
  it("allows a burst, then refills over time", () => {
    let now = 0;
    const bucket = new TokenBucket(3, 2, () => now);
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    now = 500; // +1 token at 2/s
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
    now = 10_000; // never exceeds capacity
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });
});
