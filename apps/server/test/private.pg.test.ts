// Phase 9 acceptance: two users collaborate on a private (end-to-end encrypted) board through
// the real API + sync server on Postgres, and the database holds no readable board content:
// every stored update and snapshot is an envelope that isn't a Yjs update and contains none of
// the board's labels, and nothing else the server keeps (title, audit log, AI usage) does.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type * as Y from "yjs";
import { extractGraph } from "@whiteboard/graph";
import { board } from "@whiteboard/graph/testing";
import {
  aiUsage,
  auditLogs,
  boardMembers,
  boards,
  boardSnapshots,
  boardUpdateArchive,
  boardUpdates,
  entitlements,
  eq,
  reviews,
  type Database,
  type SqlClient,
} from "@whiteboard/shared/db";
import {
  bytesToBase64,
  createKeyCheck,
  encryptText,
  generateRoomKeyString,
  importRoomKey,
  type RoomKey,
} from "@whiteboard/shared/sync";
import type { Shape } from "@whiteboard/shared/board";
import { fakeAiConfig, FakeModel, finding, minimalReview, okJson, readEvents } from "./aiHelpers";
import {
  createAuthUser,
  createOwnedBoard,
  createTestAuth,
  deleteAuthUsers,
  startApiServer,
  ticketedEncryptedClient,
  type ApiServer,
  type TestUser,
} from "./authHelpers";
import { connectTestDb } from "./pgHelpers";
import { assertOpaque } from "./privateAssertions";

let db: Database;
let sql: SqlClient;
let auth: Awaited<ReturnType<typeof createTestAuth>>;
let server: ApiServer;
const model = new FakeModel();
const users = {} as Record<"owner" | "friend" | "free", TestUser>;
const tokens = {} as Record<keyof typeof users, string>;
const clients: { provider: { destroy(): void } }[] = [];

/** Unique labels, so a match in stored bytes can only come from this test's board. */
const tag = crypto.randomUUID().slice(0, 8);
const LABELS = {
  title: `Checkout system ${tag}`,
  client: `Mobile app ${tag}`,
  service: `Payments service ${tag}`,
  database: `Ledger database ${tag}`,
  cache: `Session cache ${tag}`,
  arrow: `charge card ${tag}`,
};

function shapes(): Shape[] {
  return board()
    .add("client", "c1", { label: LABELS.client })
    .add("service", "s1", { label: LABELS.service })
    .add("database", "d1", { label: LABELS.database })
    .add("cache", "k1", { label: LABELS.cache })
    .arrow("c1", "s1", { id: "a1", label: LABELS.arrow })
    .arrow("s1", "d1", { id: "a2" })
    .arrow("s1", "k1", { id: "a3" })
    .build();
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Creates a private board through the API the way the browser does. */
async function createPrivateBoard(token: string): Promise<{ status: number; roomKey: RoomKey }> {
  const roomKey = await importRoomKey(crypto.randomUUID(), generateRoomKeyString());
  const res = await server.request("POST", "/boards", {
    token,
    body: {
      private: {
        id: roomKey.boardId,
        keyCheck: bytesToBase64(await createKeyCheck(roomKey)),
        encryptedTitle: bytesToBase64(await encryptText(roomKey, "title", LABELS.title)),
      },
    },
  });
  return { status: res.status, roomKey };
}

function connect(roomKey: RoomKey, who: keyof typeof users) {
  const client = ticketedEncryptedClient(server, roomKey, tokens[who]);
  clients.push(client);
  return client;
}

function labelsIn(doc: Y.Doc): string[] {
  return Object.values(doc.getMap("shapes").toJSON())
    .map((s) => (s as { label?: string }).label ?? "")
    .filter(Boolean)
    .sort();
}

beforeAll(async () => {
  ({ db, sql } = await connectTestDb());
  auth = await createTestAuth();
  for (const who of ["owner", "friend", "free"] as const) {
    users[who] = await createAuthUser(sql, who);
    tokens[who] = await auth.sign(users[who]);
  }
  await db.insert(entitlements).values({ userId: users.owner.id, plan: "pro" });
  // A small threshold so the test also exercises client-made snapshots and the archive.
  server = await startApiServer(db, auth.verifier, { ai: fakeAiConfig(model), snapshotEvery: 5 });
});

afterAll(async () => {
  for (const c of clients) c.provider.destroy();
  await server.stop();
  await deleteAuthUsers(
    sql,
    Object.values(users).map((u) => u.id),
  );
  await sql.end();
});

describe("private boards (end-to-end encrypted)", () => {
  it("need Pro or Team", async () => {
    const { status } = await createPrivateBoard(tokens.free);
    expect(status).toBe(402);
  });

  it("two users collaborate normally and the database holds no readable board content", async () => {
    const { status, roomKey } = await createPrivateBoard(tokens.owner);
    expect(status).toBe(201);
    const boardId = roomKey.boardId;
    await db.insert(boardMembers).values({ boardId, userId: users.friend.id, role: "editor" });

    const detail = await server.request("GET", `/boards/${boardId}`, { token: tokens.friend });
    expect(detail.body).toMatchObject({ isPrivate: true, title: "Private board", role: "editor" });

    // Owner and friend edit concurrently; presence carries their names.
    const owner = connect(roomKey, "owner");
    const friend = connect(roomKey, "friend");
    await waitFor(
      () =>
        owner.provider.getStatus() === "connected" && friend.provider.getStatus() === "connected",
      "both connected",
    );
    const all = shapes();
    const ownerMap = owner.doc.getMap<unknown>("shapes");
    const friendMap = friend.doc.getMap<unknown>("shapes");
    for (const [i, shape] of all.entries()) {
      (i % 2 === 0 ? ownerMap : friendMap).set(shape.id, shape);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    owner.awareness.setLocalState({
      user: { id: users.owner.id, name: `Owner ${tag}`, color: "#1d4ed8" },
      cursor: { x: 1, y: 2 },
      selection: ["s1"],
      viewport: null,
    });
    await waitFor(
      () => labelsIn(owner.doc).length === 5 && labelsIn(friend.doc).length === 5,
      "convergence",
    );
    await waitFor(() => friend.awareness.getStates().has(owner.doc.clientID), "presence");
    // A deletion travels too.
    friendMap.delete("k1");
    await waitFor(() => !ownerMap.has("k1"), "the deletion");
    ownerMap.set(
      "k1",
      all.find((s) => s.id === "k1"),
    );
    await waitFor(() => friendMap.has("k1"), "the re-add");
    await waitFor(
      () => owner.provider.getSaveState() === "saved" && friend.provider.getSaveState() === "saved",
      "Saved",
    );
    expect(labelsIn(owner.doc)).toEqual(labelsIn(friend.doc));

    // Client snapshots happened (threshold 5) and updates were archived.
    await waitFor(
      () => server.sync.rooms.getEncrypted(boardId)?.log.snapshot !== null,
      "a snapshot",
    );

    // Everyone leaves; the room is evicted, so everything is in Postgres.
    owner.provider.destroy();
    friend.provider.destroy();
    await waitFor(() => server.sync.rooms.getEncrypted(boardId) === undefined, "eviction");

    const updates = await db.select().from(boardUpdates).where(eq(boardUpdates.boardId, boardId));
    const archived = await db
      .select()
      .from(boardUpdateArchive)
      .where(eq(boardUpdateArchive.boardId, boardId));
    const snapshots = await db
      .select()
      .from(boardSnapshots)
      .where(eq(boardSnapshots.boardId, boardId));
    expect(snapshots.length).toBeGreaterThan(0);
    expect(archived.length).toBeGreaterThan(0);
    const secrets = [...Object.values(LABELS), `Owner ${tag}`];
    assertOpaque(
      [
        ...updates.map((u) => u.update),
        ...archived.map((u) => u.update),
        ...snapshots.map((s) => s.state),
      ],
      secrets,
    );

    // Nothing else stored about the board is readable either.
    const [row] = await db.select().from(boards).where(eq(boards.id, boardId));
    expect(row?.title).toBe("Private board");
    expect(row?.isPrivate).toBe(true);
    assertOpaque(
      [row?.encryptedTitle ?? new Uint8Array(), row?.keyCheck ?? new Uint8Array()],
      secrets,
    );
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.boardId, boardId));
    expect(audit.map((a) => a.metadata)).toContainEqual({ private: true });
    for (const secretText of secrets) expect(JSON.stringify(audit)).not.toContain(secretText);

    // With the key, a fresh client gets the exact board back from what was stored.
    const again = connect(roomKey, "friend");
    await waitFor(() => labelsIn(again.doc).length === 5, "reload from storage");
    expect(labelsIn(again.doc)).toEqual(
      [LABELS.client, LABELS.service, LABELS.database, LABELS.cache, LABELS.arrow].sort(),
    );
    // Without it (a different key), nothing.
    const wrong = ticketedEncryptedClient(
      server,
      await importRoomKey(boardId, generateRoomKeyString()),
      tokens.friend,
    );
    clients.push(wrong);
    await waitFor(() => wrong.provider.getStatus() === "denied", "the wrong key's denial");
    expect(wrong.provider.getDeniedReason()).toBe("bad_key");
    expect(labelsIn(wrong.doc)).toEqual([]);
  });

  it("refuses features that would need to read the board", async () => {
    const { roomKey } = await createPrivateBoard(tokens.owner);
    const id = roomKey.boardId;
    const call = (method: string, path: string, body?: unknown, rawBody?: Uint8Array) =>
      server.request(method, path, {
        token: tokens.owner,
        ...(body !== undefined ? { body } : {}),
        ...(rawBody ? { rawBody, headers: { "content-type": "image/png" } } : {}),
      });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    for (const res of [
      await call("PUT", `/boards/${id}/thumbnail`, undefined, png),
      await call("POST", `/boards/${id}/duplicate`),
      await call("POST", `/boards/${id}/hints`, {}),
      await call("PATCH", `/boards/${id}/sharing`, { isPublic: true }),
      await call("POST", `/boards/${id}/interviews`, {
        questionId: "url-shortener",
        durationMinutes: 45,
        participants: [],
      }),
    ]) {
      expect(res.status).toBe(409);
      expect((res.body as { error: { code: string } }).error.code).toBe("PRIVATE_BOARD");
    }
    // Titles: plaintext refused, an encrypted one accepted.
    expect((await call("PATCH", `/boards/${id}`, { title: LABELS.title })).status).toBe(400);
    const renamed = await call("PATCH", `/boards/${id}`, {
      encryptedTitle: bytesToBase64(await encryptText(roomKey, "title", "Renamed")),
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ title: "Private board", isPrivate: true });
    // Search never matches private boards (their stored title is a placeholder).
    const found = await call("GET", "/boards?q=Private");
    expect((found.body as { boards: { id: string }[] }).boards.map((b) => b.id)).not.toContain(id);
  });

  it("AI review: only the consented graph is sent, and nothing is kept unless asked", async () => {
    const { roomKey } = await createPrivateBoard(tokens.owner);
    const id = roomKey.boardId;
    const graph = extractGraph(shapes());
    model.respond = () =>
      okJson(minimalReview([finding(["n2"], { title: "Payments service is a single instance" })]));
    const review = (body: unknown, boardId = id) =>
      fetch(`${server.url}/boards/${boardId}/reviews`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tokens.owner}` },
        body: JSON.stringify(body),
      });

    // No consent → refused, no call.
    const calls = model.calls.length;
    expect((await review({ problemStatement: "" })).status).toBe(400);
    expect((await review({ private: { graph, consent: false, store: false } })).status).toBe(400);
    // A normal board never accepts a client graph.
    const normal = await createOwnedBoard(db, users.owner);
    expect((await review({ private: { graph, consent: true, store: false } }, normal)).status).toBe(
      400,
    );
    expect(model.calls.length).toBe(calls);

    // Consent, not stored: the review streams back, only usage remains.
    const secretProblem = `Design checkout ${tag}`;
    const unstored = await review({
      problemStatement: secretProblem,
      private: { graph, consent: true, store: false },
    });
    expect(unstored.status).toBe(200);
    const events = await readEvents(unstored);
    const done = events.find((e) => (e as { type: string }).type === "done") as
      | { review: { review: { findings: { shapeIds: string[] }[] }; problemStatement: string } }
      | undefined;
    expect(done?.review.problemStatement).toBe(secretProblem);
    expect(done?.review.review.findings[0]?.shapeIds).toEqual(["s1"]);
    expect(await db.select().from(reviews).where(eq(reviews.boardId, id))).toEqual([]);
    const usage = await db.select().from(aiUsage).where(eq(aiUsage.boardId, id));
    expect(usage).toHaveLength(1);
    expect(usage[0]?.status).toBe("ok");
    const listed = await server.request("GET", `/boards/${id}/reviews`, { token: tokens.owner });
    expect((listed.body as { reviews: unknown[] }).reviews).toEqual([]);

    // Opted in: stored like any review.
    const stored = await review({ private: { graph, consent: true, store: true } });
    expect(stored.status).toBe(200);
    await readEvents(stored);
    const rows = await db.select().from(reviews).where(eq(reviews.boardId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("completed");
    expect(JSON.stringify(rows[0]?.graph)).toContain(LABELS.service);
  });
});
