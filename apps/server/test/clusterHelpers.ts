import type { IncomingMessage } from "node:http";
import { Redis } from "ioredis";
import { TICKET_PROTOCOL_PREFIX } from "@whiteboard/shared/sync";
import { RedisLease, type PersistenceLease } from "../src/cluster/lease";
import { RedisRoomBus, type RoomBus } from "../src/cluster/roomBus";
import { MemoryBoardRepository } from "../src/persistence/memoryRepository";
import type { BoardRepository } from "../src/persistence/repository";
import { RedisRevocationBus } from "../src/revocation/bus";
import type { AuthorizeConnection } from "../src/sync/auth";
import { silentLogger } from "./helpers";
import { startServer, type TestServer } from "./syncHelpers";

/** A real Redis for multi-instance tests; fails loudly (never skips) if none is configured. */
export async function connectTestRedis(): Promise<Redis> {
  const url = process.env.TEST_REDIS_URL;
  if (!url)
    throw new Error(
      "TEST_REDIS_URL is not set. Start Redis (see README → Scaling) and add " +
        "TEST_REDIS_URL=redis://127.0.0.1:6379 to apps/server/.env.",
    );
  const redis = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    await redis.connect();
    await redis.ping();
  } catch (error) {
    redis.disconnect();
    throw new Error(
      `Cannot reach Redis at ${url} (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  return redis;
}

/**
 * Test identity from the offered subprotocol "ticket.<userId>", so tests can put clients of
 * different users on different instances without the full ticket machinery.
 */
export const userFromProtocol: AuthorizeConnection = (request: IncomingMessage) => {
  const header = request.headers["sec-websocket-protocol"];
  const offered = (typeof header === "string" ? header : "")
    .split(",")
    .map((p) => p.trim())
    .find((p) => p.startsWith(TICKET_PROTOCOL_PREFIX));
  const userId = offered ? offered.slice(TICKET_PROTOCOL_PREFIX.length) : null;
  return Promise.resolve({
    ok: true,
    identity: { userId, role: "editor", linkId: null, viaPublic: false },
  });
};

export const ticketFor = (userId: string) => () =>
  Promise.resolve({ ok: true as const, ticket: userId });

export interface ClusterInstance {
  id: string;
  server: TestServer;
  bus: RoomBus;
  redis: Redis;
  revocations: RedisRevocationBus;
  /**
   * Stops this instance's rooms abruptly: no flush, no lease release, no more Redis traffic
   * (like kill -9, as far as the other instances can tell). Its clients must be dropped by
   * the test; the real-process failover test covers clients reconnecting elsewhere.
   */
  crash: () => Promise<void>;
}

export interface TestCluster {
  instances: ClusterInstance[];
  repository: BoardRepository;
  stop: () => Promise<void>;
}

/** Wraps a bus so tests can drop outgoing messages (simulating pub/sub message loss). */
export class LossyBus implements RoomBus {
  dropping = false;
  constructor(private readonly inner: RoomBus) {}
  get instanceId() {
    return this.inner.instanceId;
  }
  join(...args: Parameters<RoomBus["join"]>) {
    return this.inner.join(...args);
  }
  leave(boardId: string) {
    this.inner.leave(boardId);
  }
  publish(...args: Parameters<RoomBus["publish"]>) {
    if (!this.dropping) this.inner.publish(...args);
  }
  onReconnect(handler: () => void) {
    return this.inner.onReconnect(handler);
  }
  close() {
    return this.inner.close();
  }
}

/**
 * N sync instances in this process, sharing one Redis and one repository (the database),
 * each with its own HTTP port, like several Render instances behind the load balancer.
 */
export async function startCluster(
  count: number,
  options: {
    repository?: BoardRepository;
    flushMs?: number;
    graceMs?: number;
    leaseTtlMs?: number;
    resyncMs?: number;
    /** Replaces the Redis lease (e.g. an always-granting one to force a split brain). */
    lease?: (instanceId: string, redis: Redis) => PersistenceLease;
    wrapBus?: (bus: RoomBus) => RoomBus;
  } = {},
): Promise<TestCluster> {
  const repository = options.repository ?? new MemoryBoardRepository();
  const leaseTtlMs = options.leaseTtlMs ?? 1_500;
  const instances: ClusterInstance[] = [];
  for (let i = 1; i <= count; i++) {
    const id = `test-${i}-${crypto.randomUUID().slice(0, 8)}`;
    const redis = await connectTestRedis();
    const rawBus = new RedisRoomBus(id, redis, silentLogger);
    const bus = options.wrapBus ? options.wrapBus(rawBus) : rawBus;
    const revocations = new RedisRevocationBus(redis, silentLogger, id);
    const server = await startServer({
      repository,
      authorize: userFromProtocol,
      flushMs: options.flushMs ?? 5,
      graceMs: options.graceMs ?? 50,
      revocations,
      cluster: {
        bus,
        lease: options.lease?.(id, redis) ?? new RedisLease(redis, id, leaseTtlMs),
        leaseRenewMs: Math.floor(leaseTtlMs / 3),
        resyncMs: options.resyncMs ?? 60_000,
      },
    });
    instances.push({
      id,
      server,
      bus,
      redis,
      revocations,
      crash: async () => {
        server.sync.rooms.destroy();
        await bus.close();
        await revocations.close();
        redis.disconnect();
      },
    });
  }
  return {
    instances,
    repository,
    stop: async () => {
      for (const instance of instances) {
        try {
          await instance.server.stop();
        } catch {
          // Already crashed.
        }
        await instance.bus.close().catch(() => undefined);
        await instance.revocations.close().catch(() => undefined);
        instance.redis.disconnect();
      }
    },
  };
}
