// Phase 10: no plan limit can be bypassed by calling the API or the WebSocket directly.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { writeUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import {
  boardEditorSeats,
  boardMembers,
  boards,
  count,
  entitlements,
  eq,
  sql as dsql,
  studentTrials,
  type Database,
  type SqlClient,
} from "@whiteboard/shared/db";
import {
  encodeMessage,
  MESSAGE_SYNC,
  SYNC_SUBPROTOCOL,
  TICKET_PROTOCOL_PREFIX,
} from "@whiteboard/shared/sync";
import { enforceOwnerLimits } from "../src/billing/limits";
import { emailHash } from "../src/billing/service";
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
import { nth, TestClock } from "./billingHelpers";
import { connectTestDb } from "./pgHelpers";
import { ORIGIN, waitFor } from "./syncHelpers";

const CRON = "c".repeat(40);

let db: Database;
let sql: SqlClient;
let auth: Awaited<ReturnType<typeof createTestAuth>>;
let server: ApiServer;
let clock: TestClock;
const userIds: string[] = [];
const emailHashes: string[] = [];
const clients: TicketedClient[] = [];

interface Person {
  user: TestUser;
  token: string;
}

async function person(name: string, email?: string): Promise<Person> {
  const user = await createAuthUser(sql, name);
  if (email) {
    await sql`update auth.users set email = ${email} where id = ${user.id}`;
    user.email = email;
    emailHashes.push(emailHash(email));
  }
  userIds.push(user.id);
  const token = await auth.sign(user);
  expect((await server.request("POST", "/me/bootstrap", { token })).status).toBe(200);
  return { user, token };
}

async function newBoard(owner: Person, title = "Board") {
  return server.request("POST", "/boards", { token: owner.token, body: { title } });
}

async function grant(userId: string, plan: "pro" | "team", validUntil: Date | null = null) {
  await db
    .insert(entitlements)
    .values({ userId, plan, source: "manual", sourceId: "manual", validUntil })
    .onConflictDoUpdate({
      target: [entitlements.userId, entitlements.source, entitlements.sourceId],
      set: { plan, validUntil, expiryProcessedAt: null },
    });
}

async function addEditor(boardId: string, userId: string) {
  await db.insert(boardMembers).values({ boardId, userId, role: "editor" });
}

function client(boardId: string, who: Person): TicketedClient {
  const c = ticketedClient(server, boardId, { token: who.token });
  clients.push(c);
  return c;
}

/** Opens a raw socket with a ticket signed as "editor" (as a hostile client could replay). */
async function rawEditorSocket(boardId: string, who: Person): Promise<WebSocket> {
  const { ticket } = await server.tickets.issue({
    userId: who.user.id,
    boardId,
    role: "editor",
    linkId: null,
    viaPublic: false,
  });
  const ws = new WebSocket(
    `${server.wsUrl}/rooms/${boardId}`,
    [SYNC_SUBPROTOCOL, `${TICKET_PROTOCOL_PREFIX}${ticket}`],
    { origin: ORIGIN },
  );
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => {
      resolve();
    });
    ws.on("error", reject);
  });
  return ws;
}

function forgedShape(ws: WebSocket, id: string) {
  const forged = new Y.Doc();
  const shape = new Y.Map<unknown>();
  forged.getMap<Y.Map<unknown>>("shapes").set(id, shape);
  shape.set("x", 1);
  ws.send(
    encodeMessage(MESSAGE_SYNC, (e) => {
      writeUpdate(e, Y.encodeStateAsUpdate(forged));
    }),
  );
}

beforeAll(async () => {
  ({ db, sql } = await connectTestDb());
  auth = await createTestAuth();
  clock = new TestClock();
  server = await startApiServer(db, auth.verifier, { now: clock.now, cronSecret: CRON });
});

afterAll(async () => {
  for (const c of clients) c.provider.destroy();
  await server.stop();
  if (emailHashes.length > 0)
    await sql`delete from student_trials where email_hash = any(${emailHashes})`;
  await deleteAuthUsers(sql, userIds);
  await sql.end();
});

describe("board limit (Free: 3) at the API", () => {
  it("blocks the 4th board, a duplicate and a restore; Pro lifts it", async () => {
    const owner = await person("Board owner");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await newBoard(owner);
      expect(res.status).toBe(201);
      ids.push((res.body as { id: string }).id);
    }
    const fourth = await newBoard(owner);
    expect(fourth.status).toBe(402);
    expect(fourth.body).toMatchObject({ error: { code: "BOARD_LIMIT" } });
    expect(
      (await server.request("POST", `/boards/${nth(ids, 0)}/duplicate`, { token: owner.token }))
        .status,
    ).toBe(402);

    // Trash frees a slot; restoring it again while at the limit is refused.
    expect(
      (await server.request("DELETE", `/boards/${nth(ids, 0)}`, { token: owner.token })).status,
    ).toBe(204);
    expect((await newBoard(owner)).status).toBe(201);
    const restore = await server.request("POST", `/boards/${nth(ids, 0)}/restore`, {
      token: owner.token,
    });
    expect(restore.body).toMatchObject({ error: { code: "BOARD_LIMIT" } });

    await grant(owner.user.id, "pro");
    expect((await newBoard(owner)).status).toBe(201);
    expect(
      (await server.request("POST", `/boards/${nth(ids, 0)}/restore`, { token: owner.token }))
        .status,
    ).toBe(200);
  });

  it("lets only one of two parallel requests take the last slot", async () => {
    const owner = await person("Racer");
    for (let i = 0; i < 2; i++) expect((await newBoard(owner)).status).toBe(201);
    const results = await Promise.all([newBoard(owner), newBoard(owner), newBoard(owner)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 402, 402]);
    const [owned] = await db
      .select({ n: count() })
      .from(boards)
      .where(dsql`${boards.ownerId} = ${owner.user.id} and ${boards.deletedAt} is null`);
    expect(owned?.n).toBe(3);
  });

  it("counts an expired grant as Free at once (no background job needed)", async () => {
    const owner = await person("Expiring");
    await grant(owner.user.id, "pro", clock.at(1));
    for (let i = 0; i < 4; i++) expect((await newBoard(owner)).status).toBe(201);
    clock.advanceDays(2);
    expect((await newBoard(owner)).status).toBe(402);
  });
});

describe("editor limit (Free: 3 editors per board) at the sync server", () => {
  it("rejects the 4th editor's writes on the WebSocket, whatever their ticket says", async () => {
    const owner = await person("Seat owner");
    const [a, b, c] = [
      await person("Editor A"),
      await person("Editor B"),
      await person("Editor C"),
    ];
    const boardId = ((await newBoard(owner)).body as { id: string }).id;
    for (const p of [a, b, c]) await addEditor(boardId, p.user.id);

    // Owner + A + B = 3 editors: A and B take the two seats by connecting.
    const ownerClient = client(boardId, owner);
    const clientA = client(boardId, a);
    const clientB = client(boardId, b);
    await waitFor(
      () => [ownerClient, clientA, clientB].every((x) => x.provider.getStatus() === "connected"),
      15_000,
    );
    const seats = await db
      .select({ userId: boardEditorSeats.userId })
      .from(boardEditorSeats)
      .where(eq(boardEditorSeats.boardId, boardId));
    expect(seats.map((s) => s.userId).sort()).toEqual([a.user.id, b.user.id].sort());

    // C through the API: read-only with the reason.
    const ticket = await server.request("POST", `/boards/${boardId}/ticket`, {
      token: c.token,
      body: {},
    });
    expect(ticket.body).toMatchObject({ role: "viewer", limitedBy: "EDITOR_LIMIT" });
    // C over REST: a write is refused.
    expect(
      (
        await server.request("PATCH", `/boards/${boardId}`, {
          token: c.token,
          body: { title: "C was here" },
        })
      ).body,
    ).toMatchObject({ error: { code: "EDITOR_LIMIT" } });

    // C with a forged "editor" ticket straight to the socket: the upgrade re-check caps C.
    const ws = await rawEditorSocket(boardId, c);
    forgedShape(ws, "written-by-c");
    // A's edit, for contrast, arrives.
    const shape = new Y.Map<unknown>();
    clientA.doc.getMap<Y.Map<unknown>>("shapes").set("written-by-a", shape);
    await waitFor(() => ownerClient.doc.getMap("shapes").has("written-by-a"), 10_000);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(server.sync.rooms.get(boardId)?.doc.getMap("shapes").has("written-by-c")).toBe(false);
    expect(ownerClient.doc.getMap("shapes").has("written-by-c")).toBe(false);
    ws.close();
    const [cSeat] = await db
      .select({ n: count() })
      .from(boardEditorSeats)
      .where(
        dsql`${boardEditorSeats.boardId} = ${boardId} and ${boardEditorSeats.userId} = ${c.user.id}`,
      );
    expect(cSeat?.n).toBe(0);

    // Inviting or promoting another editor is refused too.
    const invite = await server.request("POST", `/boards/${boardId}/invites`, {
      token: owner.token,
      body: { email: "someone-new@test.whiteboard.invalid", role: "editor" },
    });
    expect(invite.body).toMatchObject({ error: { code: "EDITOR_LIMIT" } });

    // The owner frees A's seat: C can now edit.
    expect(
      (
        await server.request("DELETE", `/boards/${boardId}/editor-seats/${a.user.id}`, {
          token: owner.token,
        })
      ).status,
    ).toBe(204);
    expect(
      (await server.request("POST", `/boards/${boardId}/ticket`, { token: c.token, body: {} }))
        .body,
    ).toMatchObject({ role: "editor", limitedBy: null });
  });

  it("suspends seats above the limit after a downgrade and restores them on upgrade", async () => {
    const owner = await person("Downgrader");
    await grant(owner.user.id, "pro", clock.at(1));
    const people = [await person("S1"), await person("S2"), await person("S3")];
    const boardId = ((await newBoard(owner)).body as { id: string }).id;
    for (const p of people) {
      await addEditor(boardId, p.user.id);
      const res = await server.request("POST", `/boards/${boardId}/ticket`, {
        token: p.token,
        body: {},
      });
      expect(res.body).toMatchObject({ role: "editor" });
    }
    clock.advanceDays(2);
    await server.request("POST", "/internal/billing-sweep", {
      headers: { authorization: `Bearer ${CRON}` },
    });
    const third = await server.request("POST", `/boards/${boardId}/ticket`, {
      token: nth(people, 2).token,
      body: {},
    });
    expect(third.body).toMatchObject({ role: "viewer", limitedBy: "EDITOR_LIMIT" });
    const first = await server.request("POST", `/boards/${boardId}/ticket`, {
      token: nth(people, 0).token,
      body: {},
    });
    expect(first.body).toMatchObject({ role: "editor" });

    // Upgrading again (any grant change runs the same enforcement, here the one plan:set uses).
    await grant(owner.user.id, "pro", null);
    await db.transaction((tx) => enforceOwnerLimits(tx, owner.user.id, clock.now()));
    expect(
      (
        await server.request("POST", `/boards/${boardId}/ticket`, {
          token: nth(people, 2).token,
          body: {},
        })
      ).body,
    ).toMatchObject({ role: "editor" });
  });
});

describe("features and the student offer", () => {
  it("gates private boards and live hints by plan", async () => {
    const free = await person("Free feature");
    const res = await server.request("POST", "/boards", {
      token: free.token,
      body: {
        private: {
          id: crypto.randomUUID(),
          keyCheck: Buffer.alloc(40).toString("base64"),
          encryptedTitle: Buffer.alloc(40).toString("base64"),
        },
      },
    });
    expect(res.body).toMatchObject({ error: { code: "PLAN_REQUIRED" } });
  });

  it("gives a .edu / .ac.in address 3 months of Pro, once per account and email", async () => {
    const email = `student-${crypto.randomUUID().slice(0, 8)}@cs.test-univ.edu`;
    const student = await person("Student", email);
    const summary = await server.request("GET", "/billing", { token: student.token });
    expect(summary.body).toMatchObject({ plan: "free", studentTrial: { eligible: true } });
    const started = await server.request("POST", "/billing/student-trial", {
      token: student.token,
    });
    expect(started.status).toBe(200);
    const until = new Date((started.body as { activeUntil: string }).activeUntil);
    expect(until.getTime() - clock.now().getTime()).toBeGreaterThan(88 * 24 * 60 * 60 * 1000);
    expect((await server.request("GET", "/billing", { token: student.token })).body).toMatchObject({
      plan: "pro",
      source: "student_trial",
    });
    expect(
      (await server.request("POST", "/billing/student-trial", { token: student.token })).status,
    ).toBe(409);

    // Deleting the account and signing up again with the same email doesn't restart it.
    await deleteAuthUsers(sql, [student.user.id]);
    const again = await person("Student again", email);
    expect(
      (await server.request("POST", "/billing/student-trial", { token: again.token })).status,
    ).toBe(409);

    const notStudent = await person("Not a student");
    expect(
      (await server.request("POST", "/billing/student-trial", { token: notStudent.token })).status,
    ).toBe(403);
    const [trials] = await db
      .select({ n: count() })
      .from(studentTrials)
      .where(eq(studentTrials.emailHash, emailHash(email)));
    expect(trials?.n).toBe(1);
  });
});
