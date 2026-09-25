// Two real server processes behind a round-robin proxy, sharing Postgres and Redis. Killing
// one must move its clients to the other with no acknowledged edit lost.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { PgBoardRepository } from "../src/persistence/pgRepository";
import { TicketIssuer } from "../src/auth/tickets";
import { buildSnapshot } from "../src/sync/roomPersistence";
import {
  createAuthUser,
  createOwnedBoard,
  deleteAuthUsers,
  TEST_ISSUER,
  TEST_TICKET_SECRET,
  type TestUser,
} from "./authHelpers";
import { connectTestRedis } from "./clusterHelpers";
import { connectTestDb } from "./pgHelpers";
import { startRoundRobinProxy } from "./roundRobinProxy";
import { connectClient, ORIGIN, waitFor, type TestClient } from "./syncHelpers";

const serverDir = fileURLToPath(new URL("..", import.meta.url));
const LEASE_TTL_MS = 3_000;
const children: ChildProcess[] = [];
const clients: TestClient[] = [];
const tickets = new TicketIssuer(TEST_TICKET_SECRET);
let owner: TestUser;
let boards: string[] = [];

beforeAll(async () => {
  // Fail loudly up front if Redis isn't there (the processes would silently run alone).
  (await connectTestRedis()).disconnect();
  const { db, sql } = await connectTestDb();
  owner = await createAuthUser(sql, "Failover Owner");
  boards = [await createOwnedBoard(db, owner), await createOwnedBoard(db, owner)];
  await sql.end({ timeout: 5 });
});

afterAll(async () => {
  for (const client of clients) client.provider.destroy();
  for (const child of children) child.kill("SIGKILL");
  const { sql } = await connectTestDb();
  await deleteAuthUsers(sql, [owner.id]);
  await sql.end({ timeout: 5 });
});

function ownerClient(wsUrl: string, board: string): TestClient {
  const client = connectClient(wsUrl, board, {
    getTicket: async () => {
      const { ticket } = await tickets.issue({
        userId: owner.id,
        boardId: board,
        role: "owner",
        linkId: null,
        viaPublic: false,
      });
      return { ok: true, ticket };
    },
  });
  clients.push(client);
  return client;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

async function startInstance(port: number, name: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: serverDir,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      INSTANCE_ID: name,
      DATABASE_URL: process.env.DATABASE_URL,
      REDIS_URL: process.env.TEST_REDIS_URL,
      SYNC_LEASE_TTL_MS: String(LEASE_TTL_MS),
      CORS_ALLOWED_ORIGINS: ORIGIN,
      SUPABASE_URL: TEST_ISSUER.replace("/auth/v1", ""),
      ROOM_TICKET_SECRET: TEST_TICKET_SECRET,
      APP_URL: "http://app.test",
      LOG_LEVEL: "warn",
    },
    stdio: "ignore",
  });
  children.push(child);
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/readyz`)).ok) return child;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not start");
}

async function connectionsOn(port: number): Promise<number> {
  const text = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
  const match = /^sync_connections_active (\d+)/m.exec(text);
  return Number(match?.[1] ?? -1);
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) =>
    child.once("exit", (code) => {
      resolve(code);
    }),
  );
}

function addShapes(client: TestClient, prefix: string, count: number): string[] {
  const shapes = client.doc.getMap<Y.Map<unknown>>("shapes");
  const ids: string[] = [];
  client.doc.transact(() => {
    for (let i = 0; i < count; i++) {
      const id = `${prefix}-${i}`;
      const shape = new Y.Map<unknown>();
      shapes.set(id, shape);
      shape.set("x", i);
      ids.push(id);
    }
  });
  return ids;
}

async function storedShapeIds(boardId: string): Promise<Set<string>> {
  const { db, sql } = await connectTestDb();
  const loaded = await new PgBoardRepository(db).load(boardId);
  await sql.end({ timeout: 5 });
  const doc = new Y.Doc();
  Y.applyUpdate(
    doc,
    buildSnapshot(
      loaded.snapshot?.state ?? null,
      loaded.updates.map((u) => u.update),
    ),
  );
  return new Set(doc.getMap("shapes").keys());
}

const saved = (c: TestClient) => c.provider.getSaveState() === "saved";

/** Waits until the client has dropped its connection and connected again. */
async function reconnected(client: TestClient, since: number, timeoutMs: number): Promise<void> {
  await waitFor(() => client.statuses.slice(since).includes("connected"), timeoutMs);
}
const connected = (c: TestClient) => c.provider.getStatus() === "connected";

describe("failover between instances", () => {
  it("moves clients of a killed instance to the other one with no acknowledged edit lost", async () => {
    const [boardId] = boards;
    if (!boardId) throw new Error("board");
    const [port1, port2] = [await freePort(), await freePort()];
    const one = await startInstance(port1, "one");
    await startInstance(port2, "two");
    const proxy = await startRoundRobinProxy([port1, port2]);
    const wsUrl = `ws://127.0.0.1:${proxy.port}`;

    // Round robin: A lands on instance 1 (which becomes the room's writer), B on instance 2.
    const a = ownerClient(wsUrl, boardId);
    await waitFor(() => connected(a), 10_000);
    const b = ownerClient(wsUrl, boardId);
    await waitFor(() => connected(b), 10_000);
    expect(await connectionsOn(port1)).toBe(1);
    expect(await connectionsOn(port2)).toBe(1);

    // Edits on both instances reach the other client and are acknowledged.
    const acknowledged = [...addShapes(a, "a", 200), ...addShapes(b, "b", 100)];
    await waitFor(() => saved(a) && saved(b), 30_000);
    await waitFor(() => acknowledged.every((id) => a.doc.getMap("shapes").has(id)), 10_000);
    await waitFor(() => acknowledged.every((id) => b.doc.getMap("shapes").has(id)), 10_000);

    // More edits, then instance 1 (A's instance, and the writer) dies mid-flight.
    const inFlight = addShapes(a, "a-late", 50);
    const statusesBefore = a.statuses.length;
    one.kill("SIGKILL");
    await exited(one);
    const killedAt = Date.now();
    // B keeps editing while there is no writer.
    const duringOutage = addShapes(b, "b-outage", 25);

    // A reconnects through the proxy, which skips the dead instance.
    await reconnected(a, statusesBefore, 15_000);
    const reconnectMs = Date.now() - killedAt;
    expect(await connectionsOn(port2)).toBe(2);
    // Instance 2 takes over persistence when the lease expires; A re-sends its unsaved edits.
    await waitFor(() => saved(a) && saved(b), 30_000);
    const savedMs = Date.now() - killedAt;

    const everything = [...acknowledged, ...inFlight, ...duringOutage];
    expect(everything.every((id) => a.doc.getMap("shapes").has(id))).toBe(true);
    expect(everything.every((id) => b.doc.getMap("shapes").has(id))).toBe(true);
    const stored = await storedShapeIds(boardId);
    expect(everything.filter((id) => !stored.has(id))).toEqual([]);
    process.stdout.write(
      `[failover] kill -9: A reconnected to instance 2 in ${reconnectMs} ms; everything ` +
        `saved ${savedMs} ms after the kill (lease TTL ${LEASE_TTL_MS} ms); ` +
        `${everything.length}/${everything.length} edits stored\n`,
    );
    await proxy.close();
  });

  it("hands the room over at once on graceful shutdown (SIGTERM)", async () => {
    const [, boardId] = boards;
    if (!boardId) throw new Error("board");
    const [port1, port2] = [await freePort(), await freePort()];
    const one = await startInstance(port1, "graceful-one");
    await startInstance(port2, "graceful-two");
    const proxy = await startRoundRobinProxy([port1, port2]);
    const wsUrl = `ws://127.0.0.1:${proxy.port}`;

    const a = ownerClient(wsUrl, boardId);
    await waitFor(() => connected(a), 10_000);
    const b = ownerClient(wsUrl, boardId);
    await waitFor(() => connected(b), 10_000);
    const before = [...addShapes(a, "a", 100), ...addShapes(b, "b", 100)];
    await waitFor(() => saved(a) && saved(b), 30_000);

    const pending = addShapes(a, "a-pending", 50);
    const statusesBefore = a.statuses.length;
    one.kill("SIGTERM");
    expect(await exited(one)).toBe(0);
    const stoppedAt = Date.now();

    await reconnected(a, statusesBefore, 15_000);
    const after = addShapes(b, "b-after", 20);
    await waitFor(() => saved(a) && saved(b), 30_000);
    const savedMs = Date.now() - stoppedAt;
    // The writer released its lease on the way out: no waiting for the TTL.
    expect(savedMs).toBeLessThan(LEASE_TTL_MS);

    const stored = await storedShapeIds(boardId);
    expect([...before, ...pending, ...after].filter((id) => !stored.has(id))).toEqual([]);
    process.stdout.write(
      `[failover] SIGTERM: edits saved on the remaining instance ${savedMs} ms after shutdown\n`,
    );
    await proxy.close();
  });
});
