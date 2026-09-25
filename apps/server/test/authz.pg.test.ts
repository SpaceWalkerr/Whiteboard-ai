// Phase 4 security suite, against a real Postgres: who may do what, at the REST API AND at the
// WebSocket, and how quickly revoked access ends live sessions.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { writeSyncStep2, writeUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import {
  auditLogs,
  boardUpdates,
  count,
  eq,
  type Database,
  type SqlClient,
} from "@whiteboard/shared/db";
import {
  CLOSE_CODES,
  encodeMessage,
  MESSAGE_SYNC,
  SYNC_SUBPROTOCOL,
  TICKET_PROTOCOL_PREFIX,
} from "@whiteboard/shared/sync";
import {
  createAuthUser,
  createTestAuth,
  deleteAuthUsers,
  startApiServer,
  ticketedClient,
  TEST_ISSUER,
  type ApiServer,
  type TestUser,
  type TicketedClient,
} from "./authHelpers";
import { connectTestDb } from "./pgHelpers";
import { ORIGIN, waitFor } from "./syncHelpers";

let db: Database;
let sql: SqlClient;
let auth: Awaited<ReturnType<typeof createTestAuth>>;
let server: ApiServer;
const users: Record<
  "owner" | "editor" | "viewer" | "linkEditor" | "linkViewer" | "outsider",
  TestUser
> = {} as never;
const tokens: Record<keyof typeof users, string> = {} as never;
let board: string;
let publicBoard: string;
let editorLink: { id: string; token: string };
let viewerLink: { id: string; token: string };
const clients: TicketedClient[] = [];

async function api(
  method: string,
  path: string,
  who: keyof typeof users | null,
  body?: unknown,
  headers?: Record<string, string>,
) {
  return server.request(method, path, {
    ...(who ? { token: tokens[who] } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(headers ? { headers } : {}),
  });
}

function client(
  boardId: string,
  who: keyof typeof users | null,
  shareToken?: string,
): TicketedClient {
  const c = ticketedClient(server, boardId, {
    ...(who ? { token: tokens[who] } : {}),
    ...(shareToken ? { shareToken } : {}),
  });
  clients.push(c);
  return c;
}

function setShape(doc: Y.Doc, id: string) {
  const shapes = doc.getMap<Y.Map<unknown>>("shapes");
  const shape = new Y.Map<unknown>();
  shapes.set(id, shape);
  shape.set("x", 1);
}

beforeAll(async () => {
  ({ db, sql } = await connectTestDb());
  auth = await createTestAuth();
  server = await startApiServer(db, auth.verifier);
  for (const name of [
    "owner",
    "editor",
    "viewer",
    "linkEditor",
    "linkViewer",
    "outsider",
  ] as const) {
    users[name] = await createAuthUser(sql, name);
    tokens[name] = await auth.sign(users[name]);
  }
  expect((await api("POST", "/me/bootstrap", "owner")).status).toBe(200);
  board = (
    (await api("POST", "/boards", "owner", { title: "Matrix board" })).body as { id: string }
  ).id;
  publicBoard = (
    (await api("POST", "/boards", "owner", { title: "Public board" })).body as { id: string }
  ).id;
  expect(
    (await api("PATCH", `/boards/${publicBoard}/sharing`, "owner", { isPublic: true })).status,
  ).toBe(200);

  // Invites are accepted automatically when the invited email signs in.
  expect(
    (
      await api("POST", `/boards/${board}/invites`, "owner", {
        email: users.editor.email,
        role: "editor",
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await api("POST", `/boards/${board}/invites`, "owner", {
        email: users.viewer.email,
        role: "viewer",
      })
    ).status,
  ).toBe(201);
  expect(server.mailer.sent.map((m) => m.to)).toEqual([users.editor.email, users.viewer.email]);
  expect(server.mailer.sent[0]?.text).toContain("http://app.test/invite/");
  for (const who of ["editor", "viewer"] as const) {
    expect(
      ((await api("POST", "/me/bootstrap", who)).body as { acceptedInvites: number })
        .acceptedInvites,
    ).toBe(1);
  }

  const e = (await api("POST", `/boards/${board}/share-links`, "owner", { role: "editor" }))
    .body as { id: string; token: string };
  const v = (await api("POST", `/boards/${board}/share-links`, "owner", { role: "viewer" }))
    .body as { id: string; token: string };
  editorLink = e;
  viewerLink = v;
});

afterAll(async () => {
  for (const c of clients) c.provider.destroy();
  await server.stop();
  await deleteAuthUsers(
    sql,
    Object.values(users).map((u) => u.id),
  );
  await sql.end({ timeout: 5 });
});

interface Actor {
  label: string;
  who: keyof typeof users | null;
  shareToken?: () => string;
  board: () => string;
}
const ACTORS: (Actor & {
  can: { read: boolean; write: boolean; share: boolean; delete: boolean };
})[] = [
  {
    label: "owner",
    who: "owner",
    board: () => board,
    can: { read: true, write: true, share: true, delete: true },
  },
  {
    label: "editor",
    who: "editor",
    board: () => board,
    can: { read: true, write: true, share: false, delete: false },
  },
  {
    label: "viewer",
    who: "viewer",
    board: () => board,
    can: { read: true, write: false, share: false, delete: false },
  },
  {
    label: "editor link",
    who: "linkEditor",
    shareToken: () => editorLink.token,
    board: () => board,
    can: { read: true, write: true, share: false, delete: false },
  },
  {
    label: "viewer link",
    who: "linkViewer",
    shareToken: () => viewerLink.token,
    board: () => board,
    can: { read: true, write: false, share: false, delete: false },
  },
  {
    label: "signed-out visitor of a public board",
    who: null,
    board: () => publicBoard,
    can: { read: true, write: false, share: false, delete: false },
  },
  {
    label: "non-member",
    who: "outsider",
    board: () => board,
    can: { read: false, write: false, share: false, delete: false },
  },
  {
    label: "signed-out visitor of a private board",
    who: null,
    board: () => board,
    can: { read: false, write: false, share: false, delete: false },
  },
];

function headersFor(actor: Actor): Record<string, string> | undefined {
  return actor.shareToken ? { "x-share-token": actor.shareToken() } : undefined;
}

function denied(actor: Actor): number {
  return actor.who === null ? 401 : 403;
}

describe("authorization matrix — REST API", () => {
  for (const actor of ACTORS) {
    it(`${actor.label}: read ${actor.can.read ? "allowed" : "denied"}`, async () => {
      const res = await api(
        "GET",
        `/boards/${actor.board()}`,
        actor.who,
        undefined,
        headersFor(actor),
      );
      expect(res.status).toBe(actor.can.read ? 200 : denied(actor));
    });

    it(`${actor.label}: write ${actor.can.write ? "allowed" : "denied"}`, async () => {
      const res = await api(
        "PATCH",
        `/boards/${actor.board()}`,
        actor.who,
        { title: `Renamed by ${actor.label}` },
        headersFor(actor),
      );
      expect(res.status).toBe(actor.can.write ? 200 : actor.who === null ? 401 : 403);
    });

    it(`${actor.label}: share ${actor.can.share ? "allowed" : "denied"}`, async () => {
      const res = await api(
        "POST",
        `/boards/${actor.board()}/share-links`,
        actor.who,
        { role: "viewer" },
        headersFor(actor),
      );
      expect(res.status).toBe(actor.can.share ? 201 : actor.who === null ? 401 : 403);
    });

    it(`${actor.label}: delete ${actor.can.delete ? "allowed" : "denied"}`, async () => {
      const res = await api(
        "DELETE",
        `/boards/${actor.board()}`,
        actor.who,
        undefined,
        headersFor(actor),
      );
      expect(res.status).toBe(actor.can.delete ? 204 : actor.who === null ? 401 : 403);
      if (actor.can.delete) {
        // Undo so the rest of the suite keeps its board.
        expect((await api("POST", `/boards/${actor.board()}/restore`, actor.who)).status).toBe(200);
      }
    });
  }
});

describe("authorization matrix — WebSocket", () => {
  let observer: TicketedClient;

  beforeAll(async () => {
    observer = client(board, "owner");
    await waitFor(() => observer.provider.getStatus() === "connected", 10_000);
  });

  for (const actor of ACTORS) {
    it(`${actor.label}: ${actor.can.read ? "can" : "cannot"} open the room, ${actor.can.write ? "can" : "cannot"} write`, async () => {
      const c = client(actor.board(), actor.who, actor.shareToken?.());
      if (!actor.can.read) {
        await waitFor(() => c.provider.getStatus() === "denied", 10_000);
        expect(c.provider.getDeniedReason()).toBe(
          actor.who === null ? "unauthorized" : "forbidden",
        );
        return;
      }
      await waitFor(() => c.provider.getStatus() === "connected", 10_000);
      const shapeId = `from-${actor.label}`;
      setShape(c.doc, shapeId);
      const room = () => server.sync.rooms.get(actor.board())?.doc.getMap("shapes");
      if (actor.can.write) {
        await waitFor(() => room()?.has(shapeId) === true, 10_000);
        await waitFor(() => c.provider.getSaveState() === "saved", 10_000);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(room()?.has(shapeId)).toBe(false);
        expect(observer.doc.getMap("shapes").has(shapeId)).toBe(false);
      }
      c.provider.destroy();
    });
  }
});

describe("a viewer crafting raw Yjs messages", () => {
  it("cannot change the board, persist anything, or reach other clients", async () => {
    const observer = client(board, "owner");
    await waitFor(() => observer.provider.getStatus() === "connected", 10_000);
    const { ticket } = (await api("POST", `/boards/${board}/ticket`, "viewer", {})).body as {
      ticket: string;
    };
    const [before] = await db
      .select({ n: count() })
      .from(boardUpdates)
      .where(eq(boardUpdates.boardId, board));

    const ws = new WebSocket(
      `${server.wsUrl}/rooms/${board}`,
      [SYNC_SUBPROTOCOL, `${TICKET_PROTOCOL_PREFIX}${ticket}`],
      { origin: ORIGIN },
    );
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        resolve();
      });
      ws.on("error", reject);
    });
    const forged = new Y.Doc();
    setShape(forged, "forged-by-viewer");
    forged.getMap("meta").set("title", "pwned");
    // Both write paths: a sync step 2 (state dump) and an incremental update.
    ws.send(
      encodeMessage(MESSAGE_SYNC, (e) => {
        writeSyncStep2(e, forged);
      }),
    );
    ws.send(
      encodeMessage(MESSAGE_SYNC, (e) => {
        writeUpdate(e, Y.encodeStateAsUpdate(forged));
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 800));

    const room = server.sync.rooms.get(board);
    expect(room?.doc.getMap("shapes").has("forged-by-viewer")).toBe(false);
    expect(room?.doc.getMap("meta").get("title")).toBeUndefined();
    expect(observer.doc.getMap("shapes").has("forged-by-viewer")).toBe(false);
    const [after] = await db
      .select({ n: count() })
      .from(boardUpdates)
      .where(eq(boardUpdates.boardId, board));
    expect(after?.n).toBe(before?.n);
    ws.close();
  });
});

describe("tokens and tickets", () => {
  it("rejects expired, foreign-issuer and malformed Supabase tokens", async () => {
    const expired = await auth.sign(users.owner, { expiresIn: Math.floor(Date.now() / 1000) - 60 });
    const foreign = await auth.sign(users.owner, {
      issuer: TEST_ISSUER.replace("test-project", "someone-else"),
    });
    for (const token of [expired, foreign, "not-a-jwt"]) {
      expect((await server.request("POST", "/me/bootstrap", { token })).status).toBe(401);
    }
    expect(
      (await server.request("POST", "/me/bootstrap", { headers: { authorization: "Basic abc" } }))
        .status,
    ).toBe(401);
  });

  it("refuses upgrades without a ticket, with a tampered ticket, or with another board's ticket", async () => {
    const upgrade = (protocols: string[]) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(`${server.wsUrl}/rooms/${board}`, protocols, { origin: ORIGIN });
        ws.on("unexpected-response", (_req, res) => {
          resolve(res.statusCode ?? 0);
          ws.terminate();
        });
        ws.on("open", () => {
          resolve(101);
          ws.close();
        });
        ws.on("error", () => undefined);
      });
    const { ticket } = (await api("POST", `/boards/${publicBoard}/ticket`, "owner", {})).body as {
      ticket: string;
    };
    const valid = (
      (await api("POST", `/boards/${board}/ticket`, "owner", {})).body as { ticket: string }
    ).ticket;
    expect(await upgrade([SYNC_SUBPROTOCOL])).toBe(401);
    expect(
      await upgrade([SYNC_SUBPROTOCOL, `${TICKET_PROTOCOL_PREFIX}${valid.slice(0, -4)}AAAA`]),
    ).toBe(401);
    expect(await upgrade([SYNC_SUBPROTOCOL, `${TICKET_PROTOCOL_PREFIX}${ticket}`])).toBe(401);
    expect(await upgrade([SYNC_SUBPROTOCOL, `${TICKET_PROTOCOL_PREFIX}${valid}`])).toBe(101);
  });
});

describe("revocation ends live sessions within seconds", () => {
  it("removing a member disconnects them, and their old ticket no longer works", async () => {
    const viewerClient = client(board, "viewer");
    await waitFor(() => viewerClient.provider.getStatus() === "connected", 10_000);
    const staleTicket = (
      (await api("POST", `/boards/${board}/ticket`, "viewer", {})).body as { ticket: string }
    ).ticket;

    const started = Date.now();
    expect(
      (await api("DELETE", `/boards/${board}/members/${users.viewer.id}`, "owner")).status,
    ).toBe(204);
    await waitFor(() => viewerClient.closeCodes.includes(CLOSE_CODES.accessChanged), 3_000);
    await waitFor(() => viewerClient.provider.getStatus() === "denied", 5_000);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(viewerClient.provider.getDeniedReason()).toBe("forbidden");

    // A ticket issued before the removal is re-checked against the database on upgrade.
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(
        `${server.wsUrl}/rooms/${board}`,
        [SYNC_SUBPROTOCOL, `${TICKET_PROTOCOL_PREFIX}${staleTicket}`],
        { origin: ORIGIN },
      );
      ws.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? 0);
        ws.terminate();
      });
      ws.on("open", () => {
        resolve(101);
        ws.close();
      });
      ws.on("error", () => undefined);
    });
    expect(status).toBe(403);
  });

  it("revoking a share link disconnects the people using it", async () => {
    const linkClient = client(board, "linkViewer", viewerLink.token);
    await waitFor(() => linkClient.provider.getStatus() === "connected", 10_000);
    expect(
      (await api("DELETE", `/boards/${board}/share-links/${viewerLink.id}`, "owner")).status,
    ).toBe(204);
    await waitFor(() => linkClient.closeCodes.includes(CLOSE_CODES.accessChanged), 3_000);
    await waitFor(() => linkClient.provider.getStatus() === "denied", 5_000);
  });

  it("downgrading an editor to viewer reconnects them read-only", async () => {
    const editorClient = client(board, "editor");
    await waitFor(() => editorClient.provider.getStatus() === "connected", 10_000);
    expect(
      (
        await api("PATCH", `/boards/${board}/members/${users.editor.id}`, "owner", {
          role: "viewer",
        })
      ).status,
    ).toBe(200);
    await waitFor(() => editorClient.closeCodes.includes(CLOSE_CODES.accessChanged), 3_000);
    await waitFor(() => editorClient.provider.getStatus() === "connected", 5_000);
    setShape(editorClient.doc, "after-downgrade");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(server.sync.rooms.get(board)?.doc.getMap("shapes").has("after-downgrade")).toBe(false);
  });

  it("turning off public access disconnects signed-out visitors", async () => {
    const anon = client(publicBoard, null);
    await waitFor(() => anon.provider.getStatus() === "connected", 10_000);
    expect(
      (await api("PATCH", `/boards/${publicBoard}/sharing`, "owner", { isPublic: false })).status,
    ).toBe(200);
    await waitFor(() => anon.provider.getStatus() === "denied", 5_000);
    expect(anon.provider.getDeniedReason()).toBe("unauthorized");
  });

  it("deleting a board disconnects everyone", async () => {
    const owner = client(publicBoard, "owner");
    await waitFor(() => owner.provider.getStatus() === "connected", 10_000);
    expect((await api("DELETE", `/boards/${publicBoard}`, "owner")).status).toBe(204);
    await waitFor(() => owner.provider.getStatus() === "denied", 5_000);
    expect(owner.provider.getDeniedReason()).toBe("not_found");
  });
});

describe("audit log", () => {
  it("records every share, role and delete action", async () => {
    const rows = await db
      .select({ action: auditLogs.action, actorId: auditLogs.actorId })
      .from(auditLogs)
      .where(eq(auditLogs.boardId, board));
    const actions = rows.map((r) => r.action);
    for (const expected of [
      "board.create",
      "invite.create",
      "invite.accept",
      "share_link.create",
      "share_link.revoke",
      "member.role_change",
      "member.remove",
      "board.delete",
      "board.restore",
    ]) {
      expect(actions, expected).toContain(expected);
    }
    expect(actions.filter((a) => a === "invite.accept")).toHaveLength(2);
    const publicRows = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.boardId, publicBoard));
    expect(publicRows.map((r) => r.action)).toEqual(
      expect.arrayContaining(["board.public_on", "board.public_off", "board.delete"]),
    );
    expect(rows.every((r) => r.actorId !== null)).toBe(true);
  });
});

describe("rate limits", () => {
  it("limits ticket requests per user", async () => {
    // The limiter uses fixed one-minute windows (60 per window). One burst of 130 requests
    // exceeds the limit in at least one window even if a window boundary falls inside it.
    const statuses = await Promise.all(
      Array.from({ length: 130 }, () => api("POST", `/boards/${board}/ticket`, "outsider", {})),
    );
    expect(statuses.map((r) => r.status)).toContain(429);
  });

  it("limits invites per user", async () => {
    let last = 0;
    for (let i = 0; i < 21; i++) {
      last = (
        await api("POST", `/boards/${board}/invites`, "owner", {
          email: `bulk-${i}-${crypto.randomUUID().slice(0, 6)}@test.whiteboard.invalid`,
          role: "viewer",
        })
      ).status;
    }
    expect(last).toBe(429);
  });
});
