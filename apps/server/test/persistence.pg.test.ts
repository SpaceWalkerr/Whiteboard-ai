// Persistence against a real Postgres (Supabase dev project locally, supabase/postgres in CI).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { writeUpdate } from "y-protocols/sync";
import { BoardStore, keysAbove, type Shape } from "@whiteboard/shared/board";
import { boardUpdateArchive, boardUpdates, count, eq, type Database } from "@whiteboard/shared/db";
import { encodeMessage, MESSAGE_SYNC } from "@whiteboard/shared/sync";
import { PgBoardRepository } from "../src/persistence/pgRepository";
import { buildSnapshot } from "../src/sync/roomPersistence";
import { createBareBoard } from "./authHelpers";
import { connectTestDb } from "./pgHelpers";
import { connectClient, rawSocket, sameState, startServer, waitFor } from "./syncHelpers";

let db: Database;
let close: () => Promise<void>;
let cleanup: (ids: string[]) => Promise<void>;
const created: string[] = [];

beforeAll(async () => {
  const conn = await connectTestDb();
  db = conn.db;
  cleanup = conn.cleanup;
  close = () => conn.sql.end({ timeout: 5 });
});

afterAll(async () => {
  await cleanup(created);
  await close();
});

async function newBoard(): Promise<string> {
  const id = await createBareBoard(db);
  created.push(id);
  return id;
}

async function rows(
  table: typeof boardUpdates | typeof boardUpdateArchive,
  boardId: string,
): Promise<number> {
  const [row] = await db.select({ n: count() }).from(table).where(eq(table.boardId, boardId));
  return row?.n ?? 0;
}

describe("Postgres persistence", () => {
  it("writes 10,000 updates, compacts them, and reloads exactly the same document", async () => {
    const boardId = await newBoard();
    const repository = new PgBoardRepository(db);
    const server = await startServer({
      repository,
      flushMs: 50,
      snapshotEvery: 2000,
      graceMs: 10,
      perSecond: 100_000,
      burst: 100_000,
    });

    // 10,000 individual updates, each sent as its own message.
    const original = new Y.Doc();
    const updates: Uint8Array[] = [];
    original.on("update", (u: Uint8Array) => updates.push(u));
    const shapes = original.getMap<Y.Map<unknown>>("shapes");
    for (let i = 0; i < 100; i++) shapes.set(`s${i}`, new Y.Map());
    for (let i = 0; updates.length < 10_000; i++) shapes.get(`s${i % 100}`)?.set("x", i);
    expect(updates).toHaveLength(10_000);

    const ws = await rawSocket(server.wsUrl, boardId);
    for (const update of updates) {
      ws.send(
        encodeMessage(MESSAGE_SYNC, (encoder) => {
          writeUpdate(encoder, update);
        }),
      );
    }
    ws.close();
    // Eviction (last client gone) flushes the rest and compacts.
    await waitFor(() => server.sync.rooms.size === 0, 60_000);
    await server.stop();

    expect(await rows(boardUpdates, boardId)).toBe(0);
    expect(await rows(boardUpdateArchive, boardId)).toBe(10_000);

    const loaded = await repository.load(boardId);
    const reloaded = new Y.Doc();
    if (loaded.snapshot) Y.applyUpdate(reloaded, loaded.snapshot.state);
    for (const u of loaded.updates) Y.applyUpdate(reloaded, u.update);
    expect(loaded.maxSeq).toBe(10_000);
    expect(sameState(reloaded, original)).toBe(true);
  });

  it("loads snapshot + later updates", async () => {
    const boardId = await newBoard();
    const repository = new PgBoardRepository(db);
    const doc = new Y.Doc();
    const log: Uint8Array[] = [];
    doc.on("update", (u: Uint8Array) => log.push(u));
    doc.getMap("shapes").set("a", 1);
    doc.getMap("shapes").set("b", 2);
    await repository.append(
      boardId,
      log.map((update, i) => ({ seq: i + 1, update, clientId: null, userId: null })),
    );
    await repository.compact(boardId, buildSnapshot);
    log.length = 0;
    doc.getMap("shapes").set("c", 3);
    await repository.append(boardId, [
      { seq: 3, update: log[0] ?? new Uint8Array(), clientId: 7, userId: "guest-x" },
    ]);

    const loaded = await repository.load(boardId);
    expect(loaded.snapshot?.seqUpto).toBe(2);
    expect(loaded.updates.map((u) => [u.seq, u.clientId, u.userId])).toEqual([[3, 7, "guest-x"]]);
    const reloaded = new Y.Doc();
    if (loaded.snapshot) Y.applyUpdate(reloaded, loaded.snapshot.state);
    for (const u of loaded.updates) Y.applyUpdate(reloaded, u.update);
    expect(reloaded.getMap("shapes").toJSON()).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("loads a 2,000-shape board quickly (cold room, from Postgres)", async () => {
    const boardId = await newBoard();
    const repository = new PgBoardRepository(db);

    // Build a realistic board: 2,000 system shapes with some edit history. Capture updates from
    // the doc's very first transaction: Yjs needs a client's updates without gaps.
    const doc = new Y.Doc();
    const log: Uint8Array[] = [];
    doc.on("update", (u: Uint8Array) => log.push(u));
    const store = new BoardStore({ doc });
    const keys = keysAbove(null, 2000);
    const style = {
      fill: "#ffffff",
      stroke: "#1f2937",
      strokeWidth: 2,
      strokeStyle: "solid" as const,
      fontSize: 16,
      opacity: 1,
    };
    const shapes: Shape[] = Array.from({ length: 2000 }, (_, i) => ({
      id: crypto.randomUUID(),
      type: "service",
      x: (i % 50) * 240,
      y: Math.floor(i / 50) * 160,
      w: 160,
      h: 96,
      rotation: 0,
      zIndex: keys[i] ?? "a0",
      style,
      groupId: null,
      createdBy: "seed",
      updatedAt: 0,
      label: `Service ${i}`,
    }));
    store.createShapes(shapes);
    for (let round = 0; round < 5; round++) {
      store.updateShapes(shapes.map((s) => ({ id: s.id, patch: { x: s.x + round } })));
    }
    await repository.append(
      boardId,
      log.map((update, i) => ({ seq: i + 1, update, clientId: null, userId: null })),
    );
    await repository.compact(boardId, buildSnapshot);

    const server = await startServer({ repository });
    const started = performance.now();
    const reader = connectClient(server.wsUrl, boardId);
    await waitFor(() => reader.doc.getMap("shapes").size === 2000, 30_000);
    const elapsed = Math.round(performance.now() - started);
    process.stdout.write(`[perf] cold load of a 2,000-shape board from Postgres: ${elapsed} ms\n`);
    reader.provider.destroy();
    await server.stop();
    expect(elapsed).toBeLessThan(1500);
  });
});
