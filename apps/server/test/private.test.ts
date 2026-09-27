import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { WebSocket } from "ws";
import { Awareness } from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import {
  CLOSE_CODES,
  encodeClientUpdate,
  encodeMessage,
  encodeSnapshotReply,
  encryptBytes,
  generateRoomKeyString,
  importRoomKey,
  MESSAGE_SYNC,
  SYNC_SUBPROTOCOL,
  type RoomKey,
} from "@whiteboard/shared/sync";
import { MemoryBoardRepository } from "../src/persistence/memoryRepository";
import {
  allowEncryptedConnections,
  closeCode,
  connectClient,
  connectEncryptedClient,
  ORIGIN,
  sameState,
  startServer,
  waitFor,
  type EncryptedTestClient,
  type TestClient,
  type TestServer,
} from "./syncHelpers";
import { assertOpaque, readableUpdate } from "./privateAssertions";

let servers: TestServer[] = [];
let clients: (EncryptedTestClient | TestClient)[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const c of clients) c.provider.destroy();
  for (const ws of sockets) ws.terminate();
  for (const s of servers) await s.stop().catch(() => undefined);
  clients = [];
  servers = [];
  sockets.length = 0;
});

async function privateServer(options: Parameters<typeof startServer>[0] = {}) {
  const s = await startServer({ authorize: allowEncryptedConnections, ...options });
  servers.push(s);
  return s;
}

async function newKey(boardId: string = crypto.randomUUID()): Promise<RoomKey> {
  return importRoomKey(boardId, generateRoomKeyString());
}

function client(
  s: TestServer,
  key: RoomKey,
  options: Parameters<typeof connectEncryptedClient>[2] = {},
) {
  const c = connectEncryptedClient(s.wsUrl, key, options);
  clients.push(c);
  return c;
}

/** A shape with a recognisable label (what must never reach the server in plaintext). */
function put(doc: Y.Doc, id: string, label: string, x = 0) {
  const shapes = doc.getMap<Y.Map<unknown>>("shapes");
  const shape = new Y.Map<unknown>();
  shapes.set(id, shape);
  shape.set("label", label);
  shape.set("x", x);
}

function labels(doc: Y.Doc): string[] {
  return [...doc.getMap<Y.Map<unknown>>("shapes").values()]
    .map((s) => String(s.get("label")))
    .sort();
}

function openRaw(s: TestServer, boardId: string, query = ""): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${s.wsUrl}/rooms/${boardId}${query}`, [SYNC_SUBPROTOCOL], {
      origin: ORIGIN,
    });
    sockets.push(ws);
    ws.on("open", () => {
      resolve(ws);
    });
    ws.on("error", reject);
  });
}

describe("private rooms (end-to-end encrypted)", () => {
  it("two clients collaborate: edits, deletions and presence both ways; Saved works", async () => {
    const repository = new MemoryBoardRepository();
    const s = await privateServer({ repository });
    const key = await newKey();
    const a = client(s, key);
    const b = client(s, key);
    await waitFor(
      () => a.provider.getStatus() === "connected" && b.provider.getStatus() === "connected",
    );

    put(a.doc, "s1", "Payments service");
    put(b.doc, "s2", "Ledger database");
    await waitFor(() => labels(a.doc).length === 2 && labels(b.doc).length === 2);
    expect(labels(a.doc)).toEqual(["Ledger database", "Payments service"]);

    b.doc.getMap("shapes").delete("s1");
    await waitFor(() => !a.doc.getMap("shapes").has("s1"));
    await waitFor(
      () => a.provider.getSaveState() === "saved" && b.provider.getSaveState() === "saved",
    );
    expect(sameState(a.doc, b.doc)).toBe(true);

    a.awareness.setLocalState({
      user: { id: "u-a", name: "Ada", color: "#1d4ed8" },
      cursor: { x: 5, y: 6 },
      selection: [],
      viewport: null,
    });
    await waitFor(() => b.awareness.getStates().has(a.doc.clientID));
    a.provider.destroy();
    await waitFor(() => !b.awareness.getStates().has(a.doc.clientID));

    const stored = repository.boards.get(key.boardId);
    expect(stored?.updates.length).toBeGreaterThan(0);
    assertOpaque(
      (stored?.updates ?? []).map((u) => u.update),
      ["Payments service", "Ledger database", "Ada"],
    );
  });

  it("a reconnecting client gets the board back and sends its offline edits (incl. deletions)", async () => {
    const s = await privateServer();
    const key = await newKey();
    const a = client(s, key);
    await waitFor(() => a.provider.getStatus() === "connected");
    put(a.doc, "s1", "Cache");
    put(a.doc, "s2", "Queue");
    await waitFor(() => a.provider.getSaveState() === "saved");

    // B edits while "offline" (no provider yet), then connects.
    const bDoc = new Y.Doc();
    Y.applyUpdate(bDoc, Y.encodeStateAsUpdate(a.doc));
    bDoc.getMap("shapes").delete("s1");
    put(bDoc, "s3", "Worker");
    const b = client(s, key, { reuse: { doc: bDoc, awareness: new Awareness(bDoc) } });
    expect(b.provider.getSaveState()).toBe("saving");
    await waitFor(() => labels(a.doc).join() === "Queue,Worker");
    await waitFor(() => b.provider.getSaveState() === "saved");

    // A fresh client with the key sees exactly the same board.
    const c = client(s, key);
    await waitFor(() => labels(c.doc).join() === "Queue,Worker");
  });

  it("compacts through client snapshots and reloads from them after eviction", async () => {
    const repository = new MemoryBoardRepository();
    const s = await privateServer({ repository, snapshotEvery: 5, graceMs: 20 });
    const key = await newKey();
    const a = client(s, key);
    await waitFor(() => a.provider.getStatus() === "connected");
    for (let i = 0; i < 12; i++) {
      put(a.doc, `s${String(i)}`, `Service number ${String(i)}`);
      await waitFor(() => a.provider.getSaveState() === "saved");
    }
    await waitFor(() => (repository.boards.get(key.boardId)?.snapshots.length ?? 0) > 0);
    const board = repository.boards.get(key.boardId);
    const snapshot = board?.snapshots.at(-1);
    expect(snapshot?.seqUpto).toBeGreaterThan(0);
    expect(board?.updates.every((u) => u.seq > (snapshot?.seqUpto ?? 0))).toBe(true);
    expect(board?.archive.length).toBeGreaterThan(0);
    assertOpaque(
      [
        ...(board?.snapshots.map((x) => x.state) ?? []),
        ...(board?.updates.map((u) => u.update) ?? []),
        ...(board?.archive.map((u) => u.update) ?? []),
      ],
      ["Service number 3", "Service number 11"],
    );

    a.provider.destroy();
    await waitFor(() => s.sync.rooms.size === 0);
    const b = client(s, key);
    await waitFor(() => labels(b.doc).length === 12);
    expect(sameState(a.doc, b.doc)).toBe(true);
  });

  it("a client with the wrong key is denied (bad_key) and learns nothing", async () => {
    const s = await privateServer();
    const key = await newKey();
    const a = client(s, key);
    await waitFor(() => a.provider.getStatus() === "connected");
    put(a.doc, "s1", "Secret service");
    await waitFor(() => a.provider.getSaveState() === "saved");

    const wrong = client(s, await newKey(key.boardId));
    await waitFor(() => wrong.provider.getStatus() === "denied");
    expect(wrong.provider.getDeniedReason()).toBe("bad_key");
    expect(labels(wrong.doc)).toEqual([]);
  });

  it("refuses plaintext Yjs in a private room and encrypted messages in a normal room", async () => {
    const s = await privateServer();
    const plain = await openRaw(s, crypto.randomUUID());
    const doc = new Y.Doc();
    put(doc, "x", "plaintext");
    const closed = closeCode(plain);
    plain.send(
      encodeMessage(MESSAGE_SYNC, (e) => {
        syncProtocol.writeUpdate(e, Y.encodeStateAsUpdate(doc));
      }),
    );
    expect(await closed).toBe(CLOSE_CODES.invalidPayload);

    const normal = await startServer();
    servers.push(normal);
    const key = await newKey();
    const ws = await openRaw(normal, key.boardId);
    const closedNormal = closeCode(ws);
    ws.send(encodeClientUpdate(1, await encryptBytes(key, "update", new Uint8Array([1, 2]))));
    expect(await closedNormal).toBe(CLOSE_CODES.invalidPayload);
  });

  it("drops a viewer's updates and snapshots, and unsolicited snapshots", async () => {
    const repository = new MemoryBoardRepository();
    const s = await privateServer({ repository });
    const key = await newKey();
    const editor = client(s, key);
    const viewer = client(s, key, { query: "?role=viewer" });
    await waitFor(
      () =>
        editor.provider.getStatus() === "connected" && viewer.provider.getStatus() === "connected",
    );
    put(viewer.doc, "v1", "viewer edit");
    put(editor.doc, "e1", "editor edit");
    await waitFor(() => labels(viewer.doc).includes("editor edit"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(labels(editor.doc)).toEqual(["editor edit"]);

    const raw = await openRaw(s, key.boardId);
    raw.send(encodeSnapshotReply(12345, await encryptBytes(key, "snapshot", new Uint8Array([0]))));
    for (let i = 0; i < 100 && (await metric(s, "enc_snapshot_unsolicited")) === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await metric(s, "enc_snapshot_unsolicited")).toBe(1);
    expect(repository.boards.get(key.boardId)?.snapshots ?? []).toEqual([]);
  });

  it("closes a connection whose update counter goes backwards", async () => {
    const s = await privateServer();
    const key = await newKey();
    const ws = await openRaw(s, key.boardId);
    const closed = closeCode(ws);
    const envelope = await encryptBytes(key, "update", new Uint8Array([0, 0]));
    ws.send(encodeClientUpdate(2, envelope));
    ws.send(encodeClientUpdate(2, await encryptBytes(key, "update", new Uint8Array([0, 0]))));
    expect(await closed).toBe(CLOSE_CODES.invalidPayload);
  });

  it("a normal board client can't read a private room", async () => {
    const s = await privateServer();
    const key = await newKey();
    const a = client(s, key);
    await waitFor(() => a.provider.getStatus() === "connected");
    put(a.doc, "s1", "Private label");
    await waitFor(() => a.provider.getSaveState() === "saved");
    // A plain Yjs client's sync step is refused: it never receives the content.
    const plain = connectClient(s.wsUrl, key.boardId);
    clients.push(plain);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(plain.doc.getMap("shapes").size).toBe(0);
  });

  it("the opacity check itself catches readable data (positive control)", () => {
    expect(() => {
      assertOpaque([readableUpdate("Payments service")], ["Payments service"]);
    }).toThrow();
  });
});

async function metric(s: TestServer, type: string): Promise<number> {
  const all = await s.metrics.messages.get();
  return all.values.find((v) => v.labels.type === type)?.value ?? 0;
}
