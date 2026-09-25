// Two sync instances in one process, sharing a real Redis: room traffic crosses instances,
// exactly one instance persists each room, and the others take over when it goes away.
import type { Counter } from "prom-client";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { CLOSE_CODES } from "@whiteboard/shared/sync";
import { LocalLease } from "../src/cluster/lease";
import { roomChannel } from "../src/cluster/roomBus";
import { MemoryBoardRepository } from "../src/persistence/memoryRepository";
import { buildSnapshot } from "../src/sync/roomPersistence";
import {
  connectTestRedis,
  LossyBus,
  startCluster,
  ticketFor,
  type TestCluster,
} from "./clusterHelpers";
import { connectClient, sameState, waitFor, type TestClient } from "./syncHelpers";

let cluster: TestCluster | null = null;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.provider.destroy();
  await cluster?.stop();
  cluster = null;
});

function client(
  instance: { server: { wsUrl: string } },
  boardId: string,
  userId: string,
  clientId?: number,
): TestClient {
  const connected = connectClient(instance.server.wsUrl, boardId, {
    getTicket: ticketFor(userId),
    ...(clientId === undefined ? {} : { clientId }),
  });
  clients.push(connected);
  return connected;
}

const connected = (c: TestClient) => c.provider.getStatus() === "connected";

/** Disconnects a client for good (destroy() must only run once). */
function disconnect(c: TestClient): void {
  clients.splice(clients.indexOf(c), 1);
  c.provider.destroy();
}

function presence(userId: string, x: number) {
  return {
    user: { id: userId, name: `User ${userId.slice(0, 4)}`, color: "#1d4ed8" },
    cursor: { x, y: 0 },
    selection: [],
    viewport: null,
  };
}

function cursorX(observer: TestClient, clientId: number): number | undefined {
  const state = observer.awareness.getStates().get(clientId) as
    { cursor?: { x: number } | null } | undefined;
  return state?.cursor?.x;
}

async function waitForAsync(condition: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function count(counter: Counter, labels: Record<string, string>): Promise<number> {
  const { values } = await counter.get();
  return values
    .filter((v) => Object.entries(labels).every(([k, value]) => v.labels[k] === value))
    .reduce((sum, v) => sum + v.value, 0);
}

function storedDoc(repository: MemoryBoardRepository, boardId: string): Y.Doc {
  const board = repository.boards.get(boardId);
  const doc = new Y.Doc();
  if (!board) return doc;
  const snapshot = board.snapshots.at(-1);
  Y.applyUpdate(
    doc,
    buildSnapshot(
      snapshot?.state ?? null,
      board.updates.filter((u) => u.seq > (snapshot?.seqUpto ?? 0)).map((u) => u.update),
    ),
  );
  return doc;
}

describe("sync across instances", () => {
  it("propagates edits both ways between clients on different instances", async () => {
    cluster = await startCluster(2);
    const [one, two] = cluster.instances;
    if (!one || !two) throw new Error("cluster");
    const boardId = crypto.randomUUID();
    const a = client(one, boardId, crypto.randomUUID());
    const b = client(two, boardId, crypto.randomUUID());
    await waitFor(() => connected(a) && connected(b));

    a.doc.getMap("shapes").set("from-a", "hello");
    await waitFor(() => b.doc.getMap("shapes").get("from-a") === "hello");
    b.doc.getMap("shapes").set("from-b", "world");
    await waitFor(() => a.doc.getMap("shapes").get("from-b") === "world");

    // Concurrent conflicting edits converge to the same state everywhere.
    for (let i = 0; i < 50; i++) {
      a.doc.getMap("shapes").set(`k${i % 5}`, `a${i}`);
      b.doc.getMap("shapes").set(`k${i % 5}`, `b${i}`);
    }
    await waitFor(() => sameState(a.doc, b.doc));
    expect(a.doc.getMap("shapes").size).toBe(7);
  });

  it("propagates cursors both ways, and removes them when a client leaves", async () => {
    cluster = await startCluster(2);
    const [one, two] = cluster.instances;
    if (!one || !two) throw new Error("cluster");
    const boardId = crypto.randomUUID();
    const userA = crypto.randomUUID();
    const userB = crypto.randomUUID();
    const a = client(one, boardId, userA);
    const b = client(two, boardId, userB);
    await waitFor(() => connected(a) && connected(b));

    a.awareness.setLocalState(presence(userA, 10));
    b.awareness.setLocalState(presence(userB, 20));
    await waitFor(() => cursorX(b, a.doc.clientID) === 10 && cursorX(a, b.doc.clientID) === 20);
    a.awareness.setLocalStateField("cursor", { x: 11, y: 0 });
    await waitFor(() => cursorX(b, a.doc.clientID) === 11);

    // A newcomer on instance 2 sees the cursor of a client on instance 1 immediately.
    const c = client(two, boardId, crypto.randomUUID());
    await waitFor(() => connected(c) && cursorX(c, a.doc.clientID) === 11);

    // Leaving removes the cursor on the other instance at once (not after the 30 s timeout).
    disconnect(a);
    await waitFor(() => !b.awareness.getStates().has(a.doc.clientID), 2_000);
  });

  it("gives a late joiner on another instance edits that are not yet in the database", async () => {
    const repository = new MemoryBoardRepository();
    // A long batching window: nothing reaches the database during the test.
    cluster = await startCluster(2, { repository, flushMs: 60_000 });
    const [one, two] = cluster.instances;
    if (!one || !two) throw new Error("cluster");
    const boardId = crypto.randomUUID();
    const a = client(one, boardId, crypto.randomUUID());
    await waitFor(() => connected(a));
    for (let i = 0; i < 20; i++) a.doc.getMap("shapes").set(`s${i}`, i);
    await waitFor(
      () => (one.server.sync.rooms.get(boardId)?.doc.getMap("shapes").size ?? 0) === 20,
    );
    expect(repository.boards.get(boardId)).toBeUndefined();

    const b = client(two, boardId, crypto.randomUUID());
    await waitFor(() => b.doc.getMap("shapes").size === 20);
  });

  it("never echoes: each edit is published once, by the instance that received it", async () => {
    cluster = await startCluster(2);
    const [one, two] = cluster.instances;
    if (!one || !two) throw new Error("cluster");
    const boardId = crypto.randomUUID();
    const a = client(one, boardId, crypto.randomUUID());
    const b = client(two, boardId, crypto.randomUUID());
    await waitFor(() => connected(a) && connected(b));
    const before = {
      one: await count(one.server.metrics.clusterMessages, { kind: "update", direction: "out" }),
      two: await count(two.server.metrics.clusterMessages, { kind: "update", direction: "out" }),
    };
    let updatesAtB = 0;
    b.doc.on("update", () => (updatesAtB += 1));

    a.doc.getMap("shapes").set("once", 1);
    await waitFor(() => b.doc.getMap("shapes").get("once") === 1);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(
      (await count(one.server.metrics.clusterMessages, { kind: "update", direction: "out" })) -
        before.one,
    ).toBe(1);
    expect(
      (await count(two.server.metrics.clusterMessages, { kind: "update", direction: "out" })) -
        before.two,
    ).toBe(0);
    expect(updatesAtB).toBe(1);
  });

  it("repairs lost pub/sub messages with the periodic resync", async () => {
    const lossyBuses: LossyBus[] = [];
    cluster = await startCluster(2, {
      resyncMs: 300,
      wrapBus: (inner) => {
        const lossy = new LossyBus(inner);
        lossyBuses.push(lossy);
        return lossy;
      },
    });
    const [one, two] = cluster.instances;
    // Instance 1's publications get lost.
    const bus = lossyBuses[0];
    if (!one || !two || !bus) throw new Error("cluster");
    const boardId = crypto.randomUUID();
    const a = client(one, boardId, crypto.randomUUID());
    const b = client(two, boardId, crypto.randomUUID());
    await waitFor(() => connected(a) && connected(b));
    // Let the join handshake finish before messages start getting lost.
    await new Promise((resolve) => setTimeout(resolve, 100));

    bus.dropping = true;
    a.doc.getMap("shapes").set("lost", 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(b.doc.getMap("shapes").has("lost")).toBe(false);
    bus.dropping = false;
    // Instance 2's periodic sync request is answered by instance 1 with what it lacks.
    await waitFor(() => b.doc.getMap("shapes").get("lost") === 1, 3_000);
  });
});

describe("persistence ownership", () => {
  it("has exactly one writer per room, and acknowledges edits made on any instance", async () => {
    const repository = new MemoryBoardRepository();
    cluster = await startCluster(2, { repository });
    const [one, two] = cluster.instances;
    if (!one || !two) throw new Error("cluster");
    const boardId = crypto.randomUUID();
    const a = client(one, boardId, crypto.randomUUID());
    await waitFor(() => connected(a));
    const b = client(two, boardId, crypto.randomUUID());
    await waitFor(() => connected(b));

    const writers = async () =>
      ((await one.server.metrics.roomsWriter.get()).values[0]?.value ?? 0) +
      ((await two.server.metrics.roomsWriter.get()).values[0]?.value ?? 0);
    expect(one.server.sync.rooms.get(boardId)?.persistence?.isActive).toBe(true);
    expect(two.server.sync.rooms.get(boardId)?.persistence?.isActive).toBe(false);
    expect(await writers()).toBe(1);

    for (let i = 0; i < 30; i++) b.doc.getMap("shapes").set(`b${i}`, i);
    // B is on the non-writer: its "Saved" comes from the writer's commit, relayed over Redis.
    await waitFor(() => b.provider.getSaveState() === "saved");
    expect(storedDoc(repository, boardId).getMap("shapes").size).toBe(30);
    // Stored once, by one writer.
    const stored = repository.boards.get(boardId)?.updates ?? [];
    expect(new Set(stored.map((u) => u.seq)).size).toBe(stored.length);
    expect(stored.length).toBeLessThanOrEqual(30);
  });

  it("hands over at once when the writer leaves the room", async () => {
    const repository = new MemoryBoardRepository();
    cluster = await startCluster(2, { repository, leaseTtlMs: 30_000 });
    const [one, two] = cluster.instances;
    if (!one || !two) throw new Error("cluster");
    const boardId = crypto.randomUUID();
    const a = client(one, boardId, crypto.randomUUID());
    await waitFor(() => connected(a));
    const b = client(two, boardId, crypto.randomUUID());
    await waitFor(() => connected(b));
    expect(one.server.sync.rooms.get(boardId)?.persistence?.isActive).toBe(true);

    // The writer's last client leaves; the room is evicted there and the lease released.
    disconnect(a);
    // Much sooner than the 30 s lease TTL: the release is announced.
    await waitFor(() => two.server.sync.rooms.get(boardId)?.persistence?.isActive === true, 3_000);
    b.doc.getMap("shapes").set("after-handover", 1);
    await waitFor(() => b.provider.getSaveState() === "saved");
    expect(storedDoc(repository, boardId).getMap("shapes").get("after-handover")).toBe(1);
  });

  it("takes over after the writer dies and stores what it never committed", async () => {
    const repository = new MemoryBoardRepository();
    cluster = await startCluster(2, { repository, leaseTtlMs: 900 });
    const [one, two] = cluster.instances;
    if (!one || !two) throw new Error("cluster");
    const boardId = crypto.randomUUID();
    const userA = crypto.randomUUID();
    const a = client(one, boardId, userA, 424242);
    await waitFor(() => connected(a));
    const b = client(two, boardId, crypto.randomUUID());
    await waitFor(() => connected(b));
    a.awareness.setLocalState(presence(userA, 5));
    await waitFor(() => cursorX(b, 424242) === 5);

    // The writer's database is down: nothing A sends gets committed...
    repository.failNext = 1_000;
    for (let i = 0; i < 10; i++) a.doc.getMap("shapes").set(`a${i}`, i);
    await waitFor(() => b.doc.getMap("shapes").size === 10);
    expect(a.provider.getSaveState()).toBe("saving");
    // ...and then the writer dies, never releasing its lease. (Crash first: its client's
    // goodbye must not reach the other instance, as when the process really dies.)
    await one.crash();
    disconnect(a);
    repository.failNext = 0;

    // Instance 2 takes over once the lease expires and writes what the dead writer lacked.
    await waitFor(() => two.server.sync.rooms.get(boardId)?.persistence?.isActive === true, 5_000);
    await waitFor(() => storedDoc(repository, boardId).getMap("shapes").size === 10, 5_000);
    await waitFor(() => b.provider.getSaveState() === "saved");
    expect(two.server.sync.rooms.get(boardId)?.remoteAwareness.has(424242)).toBe(true);

    // The same tab reconnecting to instance 2 reclaims its lingering cursor at once.
    const back = connectClient(two.server.wsUrl, boardId, {
      getTicket: ticketFor(userA),
      reuse: { doc: a.doc, awareness: a.awareness },
    });
    clients.push(back);
    await waitFor(() => connected(back));
    back.awareness.setLocalStateField("cursor", { x: 7, y: 0 });
    await waitFor(() => cursorX(b, 424242) === 7);
    expect(back.provider.getSaveState()).toBe("saved");
  });

  it("stays consistent when two instances write the same room (split brain)", async () => {
    const repository = new MemoryBoardRepository();
    // Every instance believes it holds the lease.
    cluster = await startCluster(2, { repository, lease: () => new LocalLease() });
    const [one, two] = cluster.instances;
    if (!one || !two) throw new Error("cluster");
    const boardId = crypto.randomUUID();
    const a = client(one, boardId, crypto.randomUUID());
    const b = client(two, boardId, crypto.randomUUID());
    await waitFor(() => connected(a) && connected(b));
    for (let i = 0; i < 40; i++) {
      a.doc.getMap("shapes").set(`a${i}`, i);
      b.doc.getMap("shapes").set(`b${i}`, i);
    }
    await waitFor(
      () => a.provider.getSaveState() === "saved" && b.provider.getSaveState() === "saved",
    );
    await waitFor(() => sameState(a.doc, b.doc));

    const stored = repository.boards.get(boardId)?.updates ?? [];
    // Both wrote (duplicates), but seqs never clash and the stored board is exact.
    expect(new Set(stored.map((u) => u.seq)).size).toBe(stored.length);
    expect(sameState(storedDoc(repository, boardId), a.doc)).toBe(true);
  });
});

describe("security across instances", () => {
  it("rejects a client on another instance claiming someone else's cursor", async () => {
    cluster = await startCluster(2);
    const [one, two] = cluster.instances;
    if (!one || !two) throw new Error("cluster");
    const boardId = crypto.randomUUID();
    const victim = crypto.randomUUID();
    const a = client(one, boardId, victim, 777001);
    const observer = client(one, boardId, crypto.randomUUID());
    // Someone on instance 2 too, so the room is open there.
    const bystander = client(two, boardId, crypto.randomUUID());
    await waitFor(() => connected(a) && connected(observer) && connected(bystander));
    a.awareness.setLocalState(presence(victim, 1));
    await waitFor(() => two.server.sync.rooms.get(boardId)?.remoteAwareness.has(777001) === true);

    // Same Yjs client id, different signed-in user, on the other instance.
    const attacker = client(two, boardId, crypto.randomUUID(), 777001);
    await waitFor(() => connected(attacker));
    attacker.awareness.setLocalState(presence(victim, 999));
    await waitForAsync(
      async () => (await count(two.server.metrics.messages, { type: "awareness_spoofed" })) > 0,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(cursorX(observer, 777001)).toBe(1);
  });

  it("closes a revoked user's socket on another instance", async () => {
    cluster = await startCluster(2);
    const [one, two] = cluster.instances;
    if (!one || !two) throw new Error("cluster");
    const boardId = crypto.randomUUID();
    const removed = crypto.randomUUID();
    const a = client(one, boardId, removed);
    const b = client(one, boardId, crypto.randomUUID());
    await waitFor(() => connected(a) && connected(b));

    // The REST API on instance 2 revokes the membership.
    await two.revocations.publish({ type: "member", boardId, userId: removed });
    await waitForAsync(
      async () =>
        (await count(one.server.metrics.closed, { code: String(CLOSE_CODES.accessChanged) })) === 1,
    );
    expect(await count(one.server.metrics.messages, { type: "revoked" })).toBe(1);
    // The other member on instance 1 is untouched.
    expect(connected(b)).toBe(true);
  });

  it("ignores malformed messages on a room channel", async () => {
    cluster = await startCluster(2);
    const [one, two] = cluster.instances;
    if (!one || !two) throw new Error("cluster");
    const boardId = crypto.randomUUID();
    const a = client(one, boardId, crypto.randomUUID());
    const b = client(two, boardId, crypto.randomUUID());
    await waitFor(() => connected(a) && connected(b));

    const redis = await connectTestRedis();
    await redis.publish(roomChannel(boardId), Buffer.from([1, 2, 3, 250, 250]));
    await redis.publish(roomChannel(boardId), "not binary at all");
    redis.disconnect();

    a.doc.getMap("shapes").set("still-works", 1);
    await waitFor(() => b.doc.getMap("shapes").get("still-works") === 1);
  });
});
