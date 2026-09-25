import type { Redis } from "ioredis";

/**
 * Who writes a room's updates to Postgres. Exactly one instance holds a room's lease at a
 * time (in the normal case); it persists every update, local or from other instances, and
 * announces what is durable. The lease is an efficiency measure, not a correctness one:
 * writes are idempotent (seq allocated by the database, Yjs updates can be applied twice),
 * so two writers during a split brain waste space but never corrupt a board.
 */
export interface PersistenceLease {
  /** True when this instance now holds the lease (or already did). Throws if unreachable. */
  acquire(boardId: string): Promise<boolean>;
  /** Extends a lease we hold. False when it expired or someone else holds it. */
  renew(boardId: string): Promise<boolean>;
  /** Gives up the lease if we hold it. */
  release(boardId: string): Promise<void>;
}

/** Single instance: always the writer. */
export class LocalLease implements PersistenceLease {
  acquire(): Promise<boolean> {
    return Promise.resolve(true);
  }

  renew(): Promise<boolean> {
    return Promise.resolve(true);
  }

  release(): Promise<void> {
    return Promise.resolve();
  }
}

export const leaseKey = (boardId: string): string => `wb:lease:${boardId}`;

// Compare-and-set, so an instance can only extend or delete a lease it actually holds (a
// plain PEXPIRE/DEL after our lease expired would extend or delete someone else's).
const RENEW_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0`;
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0`;

/** A Redis key with a TTL; an instance that dies simply stops renewing it. */
export class RedisLease implements PersistenceLease {
  constructor(
    private readonly redis: Redis,
    private readonly instanceId: string,
    private readonly ttlMs: number,
  ) {}

  async acquire(boardId: string): Promise<boolean> {
    const set = await this.redis.set(leaseKey(boardId), this.instanceId, "PX", this.ttlMs, "NX");
    if (set === "OK") return true;
    return this.renew(boardId);
  }

  async renew(boardId: string): Promise<boolean> {
    const renewed = await this.redis.eval(
      RENEW_SCRIPT,
      1,
      leaseKey(boardId),
      this.instanceId,
      String(this.ttlMs),
    );
    return renewed === 1;
  }

  async release(boardId: string): Promise<void> {
    await this.redis.eval(RELEASE_SCRIPT, 1, leaseKey(boardId), this.instanceId);
  }
}
