import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { CLOSE_CODES } from "@whiteboard/shared/sync";
import { MemoryBoardRepository } from "../src/persistence/memoryRepository";
import {
  closeCode,
  connectClient,
  rawSocket,
  sameState,
  startServer,
  waitFor,
  type TestClient,
  type TestServer,
} from "./syncHelpers";

let servers: TestServer[] = [];
let clients: TestClient[] = [];
let BOARD = crypto.randomUUID();

beforeEach(() => {
  BOARD = crypto.randomUUID();
});

afterEach(async () => {
  for (const c of clients) c.provider.destroy();
  for (const s of servers) await s.stop().catch(() => undefined);
  clients = [];
  servers = [];
});

async function server(options: Parameters<typeof startServer>[0] = {}) {
  const s = await startServer(options);
  servers.push(s);
  return s;
}

function client(wsUrl: string, boardId = BOARD) {
  const c = connectClient(wsUrl, boardId);
  clients.push(c);
  return c;
}

function setX(doc: Y.Doc, id: string, x: number) {
  const shapes = doc.getMap<Y.Map<unknown>>("shapes");
  const shape = shapes.get(id) ?? new Y.Map<unknown>();
  if (!shapes.has(id)) shapes.set(id, shape);
  shape.set("x", x);
}

describe("persistence", () => {
  it("acknowledges edits as saved only after they are committed", async () => {
    const repository = new MemoryBoardRepository();
    const s = await server({ repository });
    const a = client(s.wsUrl);
    await waitFor(() => a.provider.getStatus() === "connected");

    setX(a.doc, "s1", 1);
    expect(a.provider.getSaveState()).toBe("saving");
    await waitFor(() => a.provider.getSaveState() === "saved");
    expect(repository.boards.get(BOARD)?.updates.length).toBeGreaterThan(0);
  });

  it("does not acknowledge during a database outage, then saves after retrying", async () => {
    const repository = new MemoryBoardRepository();
    const s = await server({ repository });
    const a = client(s.wsUrl);
    await waitFor(() => a.provider.getStatus() === "connected");

    repository.failNext = 3;
    setX(a.doc, "s1", 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(a.provider.getSaveState()).toBe("saving");
    await waitFor(() => a.provider.getSaveState() === "saved", 5000);
    expect(repository.boards.get(BOARD)?.updates.length).toBe(1);
  });

  it("batches rapid updates into few writes", async () => {
    const repository = new MemoryBoardRepository();
    const s = await server({ repository, flushMs: 50 });
    const ws = await rawSocket(s.wsUrl, BOARD);
    const doc = new Y.Doc();
    const updates: Uint8Array[] = [];
    doc.on("update", (u: Uint8Array) => updates.push(u));
    for (let i = 0; i < 100; i++) setX(doc, `s${i}`, i);
    const { encodeMessage, MESSAGE_SYNC } = await import("@whiteboard/shared/sync");
    const { writeUpdate } = await import("y-protocols/sync");
    for (const u of updates)
      ws.send(
        encodeMessage(MESSAGE_SYNC, (e) => {
          writeUpdate(e, u);
        }),
      );
    // Each new shape is two Yjs updates (create, then set x).
    await waitFor(() => repository.boards.get(BOARD)?.updates.length === updates.length);
    expect(repository.appendCalls).toBeLessThanOrEqual(3);
    ws.close();
  });

  it("reloads a board from storage after the server restarts, with no client holding it", async () => {
    const repository = new MemoryBoardRepository();
    const first = await server({ repository });
    const a = client(first.wsUrl);
    await waitFor(() => a.provider.getStatus() === "connected");
    setX(a.doc, "s1", 42);
    await waitFor(() => a.provider.getSaveState() === "saved");
    a.provider.destroy();
    await first.stop();
    servers = [];

    const second = await server({ repository });
    const b = client(second.wsUrl);
    await waitFor(
      () =>
        (b.doc.getMap<Y.Map<unknown>>("shapes").get("s1")?.get("x") as number | undefined) === 42,
    );
  });

  it("snapshots and archives a board when its room is evicted", async () => {
    const repository = new MemoryBoardRepository();
    const s = await server({ repository, graceMs: 20 });
    const a = client(s.wsUrl);
    await waitFor(() => a.provider.getStatus() === "connected");
    for (let i = 0; i < 20; i++) setX(a.doc, `s${i}`, i);
    await waitFor(() => a.provider.getSaveState() === "saved");
    a.provider.destroy();
    await waitFor(() => s.sync.rooms.size === 0);

    const stored = repository.boards.get(BOARD);
    expect(stored?.snapshots).toHaveLength(1);
    expect(stored?.updates).toHaveLength(0);
    expect(stored?.archive.length).toBeGreaterThan(0);
  });

  it("compacts when the update log reaches the threshold, keeping the full history", async () => {
    const repository = new MemoryBoardRepository();
    const s = await server({ repository, snapshotEvery: 10 });
    const a = client(s.wsUrl);
    await waitFor(() => a.provider.getStatus() === "connected");
    for (let i = 0; i < 30; i++) {
      setX(a.doc, `s${i}`, i);
      await waitFor(() => a.provider.getSaveState() === "saved");
    }
    const stored = repository.boards.get(BOARD);
    expect(stored?.snapshots.length).toBeGreaterThanOrEqual(2);
    const all = [...(stored?.archive ?? []), ...(stored?.updates ?? [])].map((u) => u.seq);
    expect(all).toEqual(Array.from({ length: all.length }, (_, i) => i + 1));
  });

  it("flushes and snapshots on graceful shutdown before closing clients", async () => {
    const repository = new MemoryBoardRepository();
    const s = await server({ repository, flushMs: 1000 });
    const a = client(s.wsUrl);
    await waitFor(() => a.provider.getStatus() === "connected");
    setX(a.doc, "s1", 7);
    await waitFor(() => s.sync.rooms.get(BOARD)?.persistence?.pendingCount === 1);

    await s.sync.close();
    const stored = repository.boards.get(BOARD);
    expect(stored?.snapshots).toHaveLength(1);
    // The final acknowledgement reached the client before its socket was closed.
    expect(a.provider.getSaveState()).toBe("saved");

    const reloaded = new Y.Doc();
    const snapshot = stored?.snapshots[0];
    if (snapshot) Y.applyUpdate(reloaded, snapshot.state);
    expect(sameState(reloaded, a.doc)).toBe(true);
  });

  it("refuses a deleted board (4404)", async () => {
    const repository = new MemoryBoardRepository();
    repository.boards.set(BOARD, {
      deleted: true,
      lastSeq: 0,
      snapshots: [],
      updates: [],
      archive: [],
    });
    const s = await server({ repository });
    const ws = await rawSocket(s.wsUrl, BOARD);
    expect(await closeCode(ws)).toBe(CLOSE_CODES.boardDeleted);
  });

  it("closes with 1011 when the board cannot be loaded, and loads on the next attempt", async () => {
    const repository = new MemoryBoardRepository();
    const s = await server({ repository });
    repository.failNext = 1;
    const ws = await rawSocket(s.wsUrl, BOARD);
    expect(await closeCode(ws)).toBe(CLOSE_CODES.internalError);
    const a = client(s.wsUrl);
    await waitFor(() => a.provider.getStatus() === "connected");
    setX(a.doc, "s1", 1);
    await waitFor(() => a.provider.getSaveState() === "saved");
  });
});
