// Phase 4b: dashboard views, folders, duplication, thumbnails and trash purge (real Postgres).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  auditLogs,
  boards,
  eq,
  sql as dsql,
  type Database,
  type SqlClient,
} from "@whiteboard/shared/db";
import { MemoryThumbnailStorage } from "../src/storage/thumbnails";
import {
  createAuthUser,
  createTestAuth,
  deleteAuthUsers,
  startApiServer,
  ticketedClient,
  type ApiServer,
  type TestUser,
  type TicketedClient,
} from "./authHelpers";
import { connectTestDb } from "./pgHelpers";
import { waitFor } from "./syncHelpers";

const CRON_SECRET = "cron-secret-0123456789abcdef-0123456789";
let db: Database;
let sql: SqlClient;
let server: ApiServer;
const thumbnails = new MemoryThumbnailStorage();
let alice: TestUser;
let bob: TestUser;
const token: Record<"alice" | "bob", string> = { alice: "", bob: "" };
const clients: TicketedClient[] = [];

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

async function api(method: string, path: string, who: "alice" | "bob", body?: unknown) {
  return server.request(method, path, {
    token: token[who],
    ...(body !== undefined ? { body } : {}),
  });
}

async function list(who: "alice" | "bob", query: string) {
  const res = await api("GET", `/boards?${query}`, who);
  expect(res.status).toBe(200);
  return (
    res.body as {
      boards: { id: string; title: string; thumbnailUrl: string | null; role: string }[];
    }
  ).boards;
}

async function createBoard(title: string): Promise<string> {
  const res = await api("POST", "/boards", "alice", { title });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

beforeAll(async () => {
  ({ db, sql } = await connectTestDb());
  const auth = await createTestAuth();
  server = await startApiServer(db, auth.verifier, { thumbnails, cronSecret: CRON_SECRET });
  alice = await createAuthUser(sql, "Alice");
  bob = await createAuthUser(sql, "Bob");
  token.alice = await auth.sign(alice);
  token.bob = await auth.sign(bob);
});

afterAll(async () => {
  for (const c of clients) c.provider.destroy();
  await server.stop();
  await deleteAuthUsers(sql, [alice.id, bob.id]);
  await sql.end({ timeout: 5 });
});

describe("dashboard views", () => {
  it("lists my boards, finds them by title, and tracks recently opened ones", async () => {
    const roadmap = await createBoard("Roadmap 2027");
    await createBoard("Payments design");
    expect((await list("alice", "view=mine")).map((b) => b.title)).toEqual(
      expect.arrayContaining(["Roadmap 2027", "Payments design"]),
    );
    expect((await list("alice", "view=mine&q=paym")).map((b) => b.title)).toEqual([
      "Payments design",
    ]);
    // Search input is a pattern for ILIKE; wildcards in it are escaped.
    expect(await list("alice", `view=mine&q=${encodeURIComponent("%")}`)).toEqual([]);

    expect(await list("alice", "view=recent")).toEqual([]);
    expect((await api("POST", `/boards/${roadmap}/ticket`, "alice", {})).status).toBe(200);
    expect((await list("alice", "view=recent")).map((b) => b.id)).toEqual([roadmap]);
  });

  it("shows boards shared with me separately from my own", async () => {
    const shared = await createBoard("Shared with Bob");
    // Only accepted invites make someone a member (a share link grants access, not membership).
    await api("POST", `/boards/${shared}/invites`, "alice", { email: bob.email, role: "viewer" });
    await api("POST", "/me/bootstrap", "bob");
    expect((await list("bob", "view=shared")).map((b) => b.title)).toEqual(["Shared with Bob"]);
    expect(await list("bob", "view=mine")).toEqual([]);
  });

  it("moves deleted boards to the trash and restores them", async () => {
    const id = await createBoard("Temporary");
    expect((await api("DELETE", `/boards/${id}`, "alice")).status).toBe(204);
    expect((await list("alice", "view=mine")).map((b) => b.id)).not.toContain(id);
    expect((await list("alice", "view=trash")).map((b) => b.id)).toContain(id);
    expect((await api("POST", `/boards/${id}/restore`, "alice")).status).toBe(200);
    expect((await list("alice", "view=mine")).map((b) => b.id)).toContain(id);
  });
});

describe("folders", () => {
  it("creates, renames, filters by and deletes folders, keeping their boards", async () => {
    const folder = (await api("POST", "/folders", "alice", { name: "Interviews" })).body as {
      id: string;
    };
    const board = await createBoard("URL shortener");
    expect((await api("PATCH", `/boards/${board}`, "alice", { folderId: folder.id })).status).toBe(
      200,
    );
    expect((await list("alice", `view=mine&folderId=${folder.id}`)).map((b) => b.title)).toEqual([
      "URL shortener",
    ]);

    expect(
      (await api("PATCH", `/folders/${folder.id}`, "alice", { name: "Mock interviews" })).status,
    ).toBe(200);
    expect(
      ((await api("GET", "/folders", "alice")).body as { folders: { name: string }[] }).folders.map(
        (f) => f.name,
      ),
    ).toContain("Mock interviews");

    expect((await api("DELETE", `/folders/${folder.id}`, "alice")).status).toBe(204);
    expect((await list("alice", "view=mine")).map((b) => b.id)).toContain(board);
  });

  it("keeps folders private to their workspace", async () => {
    const folder = (await api("POST", "/folders", "alice", { name: "Private" })).body as {
      id: string;
    };
    expect((await api("PATCH", `/folders/${folder.id}`, "bob", { name: "Mine now" })).status).toBe(
      404,
    );
    expect((await api("DELETE", `/folders/${folder.id}`, "bob")).status).toBe(404);
    const bobsBoard = (
      (await api("POST", "/boards", "bob", { title: "Bob's" })).body as { id: string }
    ).id;
    expect(
      (await api("PATCH", `/boards/${bobsBoard}`, "bob", { folderId: folder.id })).status,
    ).toBe(404);
  });
});

describe("duplicate", () => {
  it("copies the current content into my workspace as a new board I own", async () => {
    const source = await createBoard("Original");
    const writer = ticketedClient(server, source, { token: token.alice });
    clients.push(writer);
    await waitFor(() => writer.provider.getStatus() === "connected", 10_000);
    writer.doc.getMap<Y.Map<unknown>>("shapes").set("s1", new Y.Map());
    await waitFor(() => writer.provider.getSaveState() === "saved", 10_000);

    await api("POST", `/boards/${source}/invites`, "alice", { email: bob.email, role: "viewer" });
    await api("POST", "/me/bootstrap", "bob");
    const copy = await api("POST", `/boards/${source}/duplicate`, "bob");
    expect(copy.status).toBe(201);
    const copyId = (copy.body as { id: string; role: string; title: string }).id;
    expect(copy.body).toMatchObject({ role: "owner", title: "Copy of Original" });

    const reader = ticketedClient(server, copyId, { token: token.bob });
    clients.push(reader);
    await waitFor(() => reader.doc.getMap("shapes").has("s1"), 10_000);
    const [log] = await db
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(eq(auditLogs.boardId, copyId));
    expect(log?.metadata).toMatchObject({ duplicatedFrom: source });
  });

  it("refuses to copy a board you can't see", async () => {
    const secret = await createBoard("Secret");
    expect((await api("POST", `/boards/${secret}/duplicate`, "bob")).status).toBe(403);
  });
});

describe("thumbnails", () => {
  it("stores a PNG from an editor and lists it with a short-lived signed URL", async () => {
    const id = await createBoard("With thumbnail");
    const res = await server.request("PUT", `/boards/${id}/thumbnail`, {
      token: token.alice,
      rawBody: PNG,
      headers: { "content-type": "image/png" },
    });
    expect(res.status).toBe(204);
    const listed = (await list("alice", "view=mine")).find((b) => b.id === id);
    expect(listed?.thumbnailUrl).toBe(`memory://${id}.png?expires=300`);
  });

  it("rejects non-PNG bodies and non-editors", async () => {
    const id = await createBoard("Guarded thumbnail");
    const notPng = await server.request("PUT", `/boards/${id}/thumbnail`, {
      token: token.alice,
      rawBody: new Uint8Array([1, 2, 3]),
      headers: { "content-type": "image/png" },
    });
    expect(notPng.status).toBe(400);
    const outsider = await server.request("PUT", `/boards/${id}/thumbnail`, {
      token: token.bob,
      rawBody: PNG,
      headers: { "content-type": "image/png" },
    });
    expect(outsider.status).toBe(403);
    const tooBig = await server.request("PUT", `/boards/${id}/thumbnail`, {
      token: token.alice,
      rawBody: new Uint8Array(400 * 1024),
      headers: { "content-type": "image/png" },
    });
    expect(tooBig.status).toBe(413);
  });
});

describe("trash purge job", () => {
  it("requires the cron secret", async () => {
    expect((await server.request("POST", "/internal/purge-trash")).status).toBe(401);
    expect(
      (
        await server.request("POST", "/internal/purge-trash", {
          headers: { authorization: "Bearer wrong" },
        })
      ).status,
    ).toBe(401);
  });

  it("hard-deletes boards deleted more than 30 days ago (with their thumbnail) and audits it", async () => {
    const old = await createBoard("Old trash");
    const recent = await createBoard("Recent trash");
    await server.request("PUT", `/boards/${old}/thumbnail`, {
      token: token.alice,
      rawBody: PNG,
      headers: { "content-type": "image/png" },
    });
    await api("DELETE", `/boards/${old}`, "alice");
    await api("DELETE", `/boards/${recent}`, "alice");
    await db.execute(
      dsql`update boards set deleted_at = now() - interval '31 days' where id = ${old}`,
    );

    const res = await server.request("POST", "/internal/purge-trash", {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(res.status).toBe(200);
    expect((await db.select({ id: boards.id }).from(boards).where(eq(boards.id, old))).length).toBe(
      0,
    );
    expect(
      (await db.select({ id: boards.id }).from(boards).where(eq(boards.id, recent))).length,
    ).toBe(1);
    expect(thumbnails.objects.has(`${old}.png`)).toBe(false);
    const logs = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.boardId, old));
    expect(logs.map((l) => l.action)).toContain("board.purge");
    // Restoring after the retention window is impossible.
    expect((await api("POST", `/boards/${old}/restore`, "alice")).status).toBe(404);
  });
});
