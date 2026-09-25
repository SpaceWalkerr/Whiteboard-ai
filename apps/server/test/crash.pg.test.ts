// Crash safety: kill -9 the real server process mid-editing; no acknowledged edit may be lost.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { TicketIssuer } from "../src/auth/tickets";
import {
  createAuthUser,
  createOwnedBoard,
  deleteAuthUsers,
  TEST_ISSUER,
  TEST_TICKET_SECRET,
  type TestUser,
} from "./authHelpers";
import { connectTestDb } from "./pgHelpers";
import { connectClient, ORIGIN, waitFor } from "./syncHelpers";

const serverDir = fileURLToPath(new URL("..", import.meta.url));
const children: ChildProcess[] = [];
const tickets = new TicketIssuer(TEST_TICKET_SECRET);
let owner: TestUser;
let boardId: string;
let gracefulBoardId: string;

beforeAll(async () => {
  const { db, sql } = await connectTestDb();
  owner = await createAuthUser(sql, "Crash Owner");
  boardId = await createOwnedBoard(db, owner);
  gracefulBoardId = await createOwnedBoard(db, owner);
  await sql.end({ timeout: 5 });
});

afterAll(async () => {
  for (const child of children) child.kill("SIGKILL");
  const { sql } = await connectTestDb();
  await deleteAuthUsers(sql, [owner.id]);
  await sql.end({ timeout: 5 });
});

/** The spawned server shares the test's ticket secret, so we can mint the owner's tickets. */
function ownerClient(wsUrl: string, board: string) {
  return connectClient(wsUrl, board, {
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
}

async function freePort(): Promise<number> {
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

async function startProcess(port: number, flushMs = 50): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: serverDir,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      DATABASE_URL: process.env.DATABASE_URL,
      CORS_ALLOWED_ORIGINS: ORIGIN,
      SYNC_FLUSH_MS: String(flushMs),
      SUPABASE_URL: TEST_ISSUER.replace("/auth/v1", ""),
      ROOM_TICKET_SECRET: TEST_TICKET_SECRET,
      APP_URL: "http://app.test",
    },
    stdio: "ignore",
  });
  children.push(child);
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return child;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not start");
}

function shapeIds(doc: Y.Doc): string[] {
  return [...doc.getMap("shapes").keys()];
}

describe("crash safety", () => {
  it("keeps every acknowledged edit when the server is killed with SIGKILL", async () => {
    const port = await freePort();
    const first = await startProcess(port);
    const wsUrl = `ws://127.0.0.1:${port}`;

    const writer = ownerClient(wsUrl, boardId);
    await waitFor(() => writer.provider.getStatus() === "connected", 10_000);
    const shapes = writer.doc.getMap<Y.Map<unknown>>("shapes");

    // Round 1: edits that we wait to see acknowledged.
    for (let i = 0; i < 200; i++) {
      const shape = new Y.Map<unknown>();
      shapes.set(`acked-${i}`, shape);
      shape.set("x", i);
    }
    await waitFor(() => writer.provider.getSaveState() === "saved", 30_000);
    const acknowledged = shapeIds(writer.doc);
    expect(acknowledged).toHaveLength(200);

    // Round 2: more edits, then kill -9 without waiting for them to be saved.
    for (let i = 0; i < 100; i++) shapes.set(`in-flight-${i}`, new Y.Map<unknown>());
    first.kill("SIGKILL");
    await new Promise<void>((resolve) =>
      first.once("exit", () => {
        resolve();
      }),
    );
    // The writer disappears too, so nothing can be re-sent from its memory.
    writer.provider.destroy();

    await startProcess(port);
    const reader = ownerClient(wsUrl, boardId);
    await waitFor(() => reader.provider.getStatus() === "connected", 10_000);
    await waitFor(() => acknowledged.every((id) => reader.doc.getMap("shapes").has(id)), 30_000);
    const recovered = shapeIds(reader.doc);
    process.stdout.write(
      `[crash] acknowledged ${acknowledged.length}/${acknowledged.length} recovered; ` +
        `in-flight recovered ${recovered.filter((id) => id.startsWith("in-flight")).length}/100\n`,
    );
    reader.provider.destroy();
  });

  it("flushes unsaved edits and snapshots rooms on graceful shutdown (SIGTERM)", async () => {
    const port = await freePort();
    // A long batching window: the edits are still unsaved when SIGTERM arrives.
    const server = await startProcess(port, 1_000);
    const wsUrl = `ws://127.0.0.1:${port}`;
    const writer = ownerClient(wsUrl, gracefulBoardId);
    await waitFor(() => writer.provider.getStatus() === "connected", 10_000);
    const shapes = writer.doc.getMap<Y.Map<unknown>>("shapes");
    for (let i = 0; i < 50; i++) shapes.set(`pending-${i}`, new Y.Map<unknown>());
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(writer.provider.getSaveState()).toBe("saving");

    server.kill("SIGTERM");
    const exitCode = await new Promise<number | null>((resolve) =>
      server.once("exit", (code) => {
        resolve(code);
      }),
    );
    expect(exitCode).toBe(0);
    // The final acknowledgement was sent before the server closed the socket (it may still be
    // queued in this process's event loop when the child's exit event fires).
    await waitFor(() => writer.provider.getSaveState() === "saved", 2_000);
    writer.provider.destroy();

    await startProcess(port);
    const reader = ownerClient(wsUrl, gracefulBoardId);
    await waitFor(() => reader.doc.getMap("shapes").size === 50, 30_000);
    reader.provider.destroy();
  });
});
