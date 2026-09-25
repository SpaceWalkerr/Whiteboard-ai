import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import {
  CLOSE_CODES,
  encodeAwarenessMessage,
  encodeMessage,
  MAX_CLIENT_MESSAGE_BYTES,
  MESSAGE_SYNC,
} from "@whiteboard/shared/sync";
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

afterEach(async () => {
  for (const c of clients) c.provider.destroy();
  for (const s of servers) await s.stop().catch(() => undefined);
  clients = [];
  servers = [];
});

function shape(doc: Y.Doc, id: string): Y.Map<unknown> {
  const shapes = doc.getMap<Y.Map<unknown>>("shapes");
  let yShape = shapes.get(id);
  if (!yShape) {
    yShape = new Y.Map();
    shapes.set(id, yShape);
  }
  return yShape;
}

describe("sync server", () => {
  it("propagates edits between two clients", async () => {
    const s = await server();
    const a = client(s.wsUrl);
    const b = client(s.wsUrl);
    await waitFor(
      () => a.provider.getStatus() === "connected" && b.provider.getStatus() === "connected",
    );

    shape(a.doc, "s1").set("x", 10);
    await waitFor(() => b.doc.getMap("shapes").has("s1"));
    expect(sameState(a.doc, b.doc)).toBe(true);
  });

  it("converges after concurrent conflicting edits", async () => {
    const s = await server();
    const a = client(s.wsUrl);
    const b = client(s.wsUrl);
    await waitFor(
      () => a.provider.getStatus() === "connected" && b.provider.getStatus() === "connected",
    );
    shape(a.doc, "s1").set("x", 0);
    await waitFor(() => b.doc.getMap("shapes").has("s1"));

    // Same field, different values; different fields; create on one side, delete on the other.
    shape(a.doc, "s1").set("x", 100);
    shape(b.doc, "s1").set("x", 200);
    shape(a.doc, "s1").set("fill", "#ff0000");
    shape(b.doc, "s1").set("stroke", "#00ff00");
    shape(a.doc, "s2").set("x", 1);
    b.doc.getMap("shapes").delete("s1");

    await waitFor(() => sameState(a.doc, b.doc));
    expect(a.doc.getMap("shapes").has("s2")).toBe(true);
  });

  it("merges edits made while a client was disconnected", async () => {
    const s = await server();
    const a = client(s.wsUrl);
    const b = client(s.wsUrl);
    await waitFor(
      () => a.provider.getStatus() === "connected" && b.provider.getStatus() === "connected",
    );

    // Take A "offline": destroy its provider, edit both docs, then reconnect A with a new provider.
    a.provider.destroy();
    shape(a.doc, "from-a").set("x", 1);
    shape(b.doc, "from-b").set("x", 2);
    await waitFor(() => b.doc.getMap("shapes").has("from-b"));

    const again = connectClient(s.wsUrl, BOARD);
    clients.push(again);
    Y.applyUpdate(again.doc, Y.encodeStateAsUpdate(a.doc));
    await waitFor(() => sameState(again.doc, b.doc) && b.doc.getMap("shapes").has("from-a"));
    expect(again.doc.getMap("shapes").has("from-b")).toBe(true);
  });

  it("recovers after a server restart: clients reconnect and restore the room", async () => {
    const first = await server();
    const a = client(first.wsUrl);
    await waitFor(() => a.provider.getStatus() === "connected");
    shape(a.doc, "s1").set("x", 42);
    await waitFor(() => first.sync.rooms.get(BOARD)?.doc.getMap("shapes").has("s1") === true);

    await first.stop();
    servers = [];
    await waitFor(() => a.provider.getStatus() === "reconnecting");

    const second = await server({ port: first.port });
    await waitFor(() => a.provider.getStatus() === "connected");
    // The empty restarted server received the document back from the client.
    await waitFor(() => second.sync.rooms.get(BOARD)?.doc.getMap("shapes").has("s1") === true);
    expect(a.statuses).toContain("reconnecting");

    const b = client(second.wsUrl);
    await waitFor(() => b.doc.getMap("shapes").has("s1"));
  });

  it("shares presence and removes it when a client leaves", async () => {
    const s = await server();
    const a = client(s.wsUrl);
    const b = client(s.wsUrl);
    await waitFor(
      () => a.provider.getStatus() === "connected" && b.provider.getStatus() === "connected",
    );

    a.awareness.setLocalState({
      user: { id: "u1", name: "Ada", color: "#1d4ed8" },
      cursor: { x: 1, y: 2 },
      selection: [],
      viewport: null,
    });
    await waitFor(() => b.awareness.getStates().has(a.doc.clientID));

    a.provider.destroy();
    await waitFor(() => !b.awareness.getStates().has(a.doc.clientID));
  });

  it("drops presence that fails validation", async () => {
    const s = await server();
    const a = client(s.wsUrl);
    const b = client(s.wsUrl);
    await waitFor(
      () => a.provider.getStatus() === "connected" && b.provider.getStatus() === "connected",
    );

    a.awareness.setLocalState({ user: { id: "u1", name: "", color: "blue" } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(b.awareness.getStates().has(a.doc.clientID)).toBe(false);
  });

  it("keeps different boards separate", async () => {
    const s = await server();
    const a = client(s.wsUrl, crypto.randomUUID());
    const b = client(s.wsUrl, crypto.randomUUID());
    await waitFor(
      () => a.provider.getStatus() === "connected" && b.provider.getStatus() === "connected",
    );
    shape(a.doc, "s1").set("x", 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(b.doc.getMap("shapes").size).toBe(0);
  });

  it("evicts an empty room after the grace period", async () => {
    const s = await server({ graceMs: 30 });
    const a = client(s.wsUrl);
    await waitFor(() => a.provider.getStatus() === "connected");
    expect(s.sync.rooms.size).toBe(1);
    a.provider.destroy();
    await waitFor(() => s.sync.rooms.size === 0);
  });

  it("closes connections that send oversized messages (1009)", async () => {
    const s = await server();
    const ws = await rawSocket(s.wsUrl, BOARD);
    const closed = closeCode(ws);
    ws.send(new Uint8Array(MAX_CLIENT_MESSAGE_BYTES + 10));
    expect(await closed).toBe(CLOSE_CODES.tooBig);
  });

  it("closes connections that exceed the byte budget (1008)", async () => {
    const s = await server({ bytesPerSecond: 1024, bytesBurst: 4096 });
    const ws = await rawSocket(s.wsUrl, BOARD);
    const closed = closeCode(ws);
    // A valid (empty) update padded past the budget: rejected before it is even parsed.
    ws.send(new Uint8Array(8192));
    expect(await closed).toBe(CLOSE_CODES.rateLimited);
  });

  it("syncs a board whose full state is larger than 1 MB", async () => {
    const s = await server();
    const a = client(s.wsUrl);
    await waitFor(() => a.provider.getStatus() === "connected");
    // Build a big document while "offline" from the room, then sync it in one step.
    a.provider.destroy();
    for (let i = 0; i < 4000; i++)
      shape(a.doc, `shape-${i}`).set("label", `Service number ${i} `.repeat(20));
    expect(Y.encodeStateAsUpdate(a.doc).byteLength).toBeGreaterThan(1024 * 1024);

    const again = connectClient(s.wsUrl, BOARD);
    clients.push(again);
    Y.applyUpdate(again.doc, Y.encodeStateAsUpdate(a.doc));
    const b = client(s.wsUrl);
    await waitFor(() => b.doc.getMap("shapes").size === 4000, 10_000);
  });

  it("closes connections that exceed the rate limit (1008)", async () => {
    const s = await server({ perSecond: 5, burst: 10 });
    const ws = await rawSocket(s.wsUrl, BOARD);
    const closed = closeCode(ws);
    const step1 = encodeMessage(MESSAGE_SYNC, (encoder) => {
      encoding.writeVarUint(encoder, 0);
      encoding.writeVarUint8Array(encoder, Y.encodeStateVector(new Y.Doc()));
    });
    for (let i = 0; i < 50; i++) ws.send(step1);
    expect(await closed).toBe(CLOSE_CODES.rateLimited);
  });

  it("closes connections that send malformed messages (1007)", async () => {
    const s = await server();
    const ws = await rawSocket(s.wsUrl, BOARD);
    const closed = closeCode(ws);
    ws.send(new Uint8Array([9, 9, 9]));
    expect(await closed).toBe(CLOSE_CODES.invalidPayload);
  });

  it("refuses to let one connection overwrite another client's presence", async () => {
    const s = await server();
    const a = client(s.wsUrl);
    const b = client(s.wsUrl);
    await waitFor(
      () => a.provider.getStatus() === "connected" && b.provider.getStatus() === "connected",
    );
    a.awareness.setLocalState({
      user: { id: "u1", name: "Ada", color: "#1d4ed8" },
      cursor: null,
      selection: [],
      viewport: null,
    });
    await waitFor(() => b.awareness.getStates().has(a.doc.clientID));

    // A raw socket claims A's client id with a different name.
    const { Awareness, encodeAwarenessUpdate } = await import("y-protocols/awareness");
    const forger = new Awareness(new Y.Doc());
    forger.clientID = a.doc.clientID;
    forger.setLocalState({
      user: { id: "u2", name: "Mallory", color: "#000000" },
      cursor: null,
      selection: [],
      viewport: null,
    });
    const ws = await rawSocket(s.wsUrl, BOARD);
    ws.send(encodeAwarenessMessage(encodeAwarenessUpdate(forger, [a.doc.clientID])));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const seen = b.awareness.getStates().get(a.doc.clientID) as
      { user: { name: string } } | undefined;
    expect(seen?.user.name).toBe("Ada");
    ws.close();
  });

  it("exposes Prometheus metrics behind the token", async () => {
    const s = await server({ metricsToken: "x".repeat(32) });
    const a = client(s.wsUrl);
    await waitFor(() => a.provider.getStatus() === "connected");
    shape(a.doc, "s1").set("x", 1);
    await waitFor(() => s.sync.rooms.get(BOARD)?.doc.getMap("shapes").has("s1") === true);

    expect((await fetch(`${s.httpUrl}/metrics`)).status).toBe(401);
    const res = await fetch(`${s.httpUrl}/metrics`, {
      headers: { authorization: `Bearer ${"x".repeat(32)}` },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/^sync_rooms_active 1$/m);
    expect(body).toMatch(/^sync_connections_active 1$/m);
    expect(body).toMatch(/^sync_messages_total\{type="update"\} \d+$/m);
    expect(body).toMatch(/^sync_update_bytes_total \d+$/m);
  });
});
