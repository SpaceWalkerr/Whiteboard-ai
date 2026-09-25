// Phase 8: interview mode against a real Postgres — who may do what, the Team-plan gate,
// one active interview per board, the observer / ended-candidate read-only cap (enforced on
// the WebSocket too), timer and hints, notes, scorecards, summary links, audit rows, and
// session replay reconstructed from the stored history across a compaction.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { interviewSummarySchema } from "@whiteboard/graph";
import { BoardStore } from "@whiteboard/shared/board";
import {
  interviewViewSchema,
  remainingMs,
  replayBundleSchema,
  type InterviewView,
} from "@whiteboard/shared/interview";
import { fromBase64, ReplayTimeline, shapeRecords } from "@whiteboard/shared/replay";
import {
  auditLogs,
  boardMembers,
  entitlements,
  eq,
  interviews,
  sql as dsql,
  type Database,
  type SqlClient,
} from "@whiteboard/shared/db";
import { PgBoardRepository } from "../src/persistence/pgRepository";
import { buildSnapshot } from "../src/sync/roomPersistence";
import {
  createAuthUser,
  createOwnedBoard,
  createTestAuth,
  deleteAuthUsers,
  startApiServer,
  ticketedClient,
  type ApiServer,
  type TestUser,
} from "./authHelpers";
import { connectTestDb } from "./pgHelpers";

type Who = "interviewer" | "candidate" | "observer" | "outsider" | "freeOwner";
let db: Database;
let sql: SqlClient;
let server: ApiServer;
let auth: Awaited<ReturnType<typeof createTestAuth>>;
const users = {} as Record<Who, TestUser>;
const tokens = {} as Record<Who, string>;

async function newBoard(owner: Who = "interviewer"): Promise<string> {
  const boardId = await createOwnedBoard(db, users[owner]);
  await db.insert(boardMembers).values([
    { boardId, userId: users.candidate.id, role: "editor" },
    { boardId, userId: users.observer.id, role: "editor" },
  ]);
  return boardId;
}

function call(who: Who, method: string, path: string, body?: unknown) {
  return server.request(method, path, {
    token: tokens[who],
    ...(body !== undefined ? { body } : {}),
  });
}

async function start(boardId: string, who: Who = "interviewer"): Promise<InterviewView> {
  const res = await call(who, "POST", `/boards/${boardId}/interviews`, {
    questionId: "rate-limiter",
    durationMinutes: 30,
    participants: [
      { userId: users.candidate.id, role: "candidate" },
      { userId: users.observer.id, role: "observer" },
    ],
  });
  expect(res.status).toBe(201);
  return interviewViewSchema.parse((res.body as { interview: unknown }).interview);
}

async function ticketRole(who: Who, boardId: string): Promise<string> {
  const res = await call(who, "POST", `/boards/${boardId}/ticket`, {});
  expect(res.status).toBe(200);
  return (res.body as { role: string }).role;
}

beforeAll(async () => {
  ({ db, sql } = await connectTestDb());
  auth = await createTestAuth();
  server = await startApiServer(db, auth.verifier);
  for (const who of ["interviewer", "candidate", "observer", "outsider", "freeOwner"] as const) {
    users[who] = await createAuthUser(sql, who);
    tokens[who] = await auth.sign(users[who]);
  }
  await db.insert(entitlements).values({ userId: users.interviewer.id, plan: "team" });
});

afterAll(async () => {
  await server.stop();
  await deleteAuthUsers(
    sql,
    Object.values(users).map((u) => u.id),
  );
  await sql.end();
});

describe("starting an interview", () => {
  it("needs the Team plan, write access, known question and participants with access", async () => {
    const boardId = await newBoard("freeOwner");
    // Free plan: 402 before anything is created.
    const free = await call("freeOwner", "POST", `/boards/${boardId}/interviews`, {
      questionId: "rate-limiter",
      durationMinutes: 30,
      participants: [],
    });
    expect(free.status).toBe(402);
    expect((free.body as { error: { code: string } }).error.code).toBe("PLAN_REQUIRED");
    expect((await call("freeOwner", "GET", "/interview-questions")).status).toBe(402);

    const teamBoard = await newBoard();
    expect(
      (
        await call("outsider", "POST", `/boards/${teamBoard}/interviews`, {
          questionId: "rate-limiter",
          durationMinutes: 30,
          participants: [],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call("interviewer", "POST", `/boards/${teamBoard}/interviews`, {
          questionId: "no-such-question",
          durationMinutes: 30,
          participants: [],
        })
      ).status,
    ).toBe(400);
    // The outsider has no access to the board, so can't be the candidate.
    expect(
      (
        await call("interviewer", "POST", `/boards/${teamBoard}/interviews`, {
          questionId: "rate-limiter",
          durationMinutes: 30,
          participants: [{ userId: users.outsider.id, role: "candidate" }],
        })
      ).status,
    ).toBe(400);
    // Two candidates are refused by validation.
    expect(
      (
        await call("interviewer", "POST", `/boards/${teamBoard}/interviews`, {
          questionId: "rate-limiter",
          durationMinutes: 30,
          participants: [
            { userId: users.candidate.id, role: "candidate" },
            { userId: users.observer.id, role: "candidate" },
          ],
        })
      ).status,
    ).toBe(400);

    const questions = await call("interviewer", "GET", "/interview-questions");
    expect(questions.status).toBe(200);
    expect((questions.body as { questions: unknown[] }).questions).toHaveLength(20);
  });

  it("allows one active interview per board and audits start and end", async () => {
    const boardId = await newBoard();
    const view = await start(boardId);
    expect(view.myRole).toBe("interviewer");
    expect(view.question?.hints.length).toBeGreaterThan(0);
    expect(view.state.participants.map((p) => p.role)).toEqual([
      "interviewer",
      "candidate",
      "observer",
    ]);

    const second = await call("interviewer", "POST", `/boards/${boardId}/interviews`, {
      questionId: "pastebin",
      durationMinutes: 30,
      participants: [],
    });
    expect(second.status).toBe(409);

    const id = view.state.interviewId;
    expect((await call("interviewer", "POST", `/interviews/${id}/end`)).status).toBe(200);
    // A new interview may start once the previous one has ended.
    await start(boardId);

    const actions = await db
      .select({ action: auditLogs.action, actor: auditLogs.actorId })
      .from(auditLogs)
      .where(eq(auditLogs.boardId, boardId));
    expect(actions.map((a) => a.action).sort()).toEqual([
      "interview.end",
      "interview.start",
      "interview.start",
    ]);
    expect(actions.every((a) => a.actor === users.interviewer.id)).toBe(true);
  });
});

describe("roles", () => {
  it("makes observers read-only while it runs and the candidate read-only once it ends", async () => {
    const boardId = await newBoard();
    expect(await ticketRole("observer", boardId)).toBe("editor");
    const view = await start(boardId);
    expect(await ticketRole("observer", boardId)).toBe("viewer");
    expect(await ticketRole("candidate", boardId)).toBe("editor");

    // The cap holds on the socket: an observer's edits are dropped by the server.
    const observer = ticketedClient(server, boardId, { token: tokens.observer });
    const candidate = ticketedClient(server, boardId, { token: tokens.candidate });
    try {
      await waitFor(() => observer.provider.getStatus() === "connected", "observer connected");
      await waitFor(() => candidate.provider.getStatus() === "connected", "candidate connected");
      observer.doc.getMap("shapes").set("from-observer", new Y.Map());
      candidate.doc.getMap("shapes").set("from-candidate", new Y.Map());
      await waitFor(() => observer.doc.getMap("shapes").has("from-candidate"), "candidate edit");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(candidate.doc.getMap("shapes").has("from-observer")).toBe(false);

      expect(
        (await call("interviewer", "POST", `/interviews/${view.state.interviewId}/end`)).status,
      ).toBe(200);
      // The candidate's socket is re-ticketed as a viewer.
      await waitFor(() => candidate.closeCodes.includes(4403), "candidate re-ticketed");
      expect(await ticketRole("candidate", boardId)).toBe("viewer");
      expect(await ticketRole("observer", boardId)).toBe("editor");
    } finally {
      observer.provider.destroy();
      candidate.provider.destroy();
    }
  });

  it("accepts a candidate who joined through a share link, and makes them read-only at the end", async () => {
    const boardId = await newBoard();
    const link = await call("interviewer", "POST", `/boards/${boardId}/share-links`, {
      role: "editor",
    });
    expect(link.status).toBe(201);
    const shareToken = (link.body as { token: string }).token;
    const linkTicket = async () => {
      const res = await server.request("POST", `/boards/${boardId}/ticket`, {
        token: tokens.outsider,
        body: { shareToken },
      });
      expect(res.status).toBe(200);
      return (res.body as { role: string }).role;
    };
    const assign = () =>
      call("interviewer", "POST", `/boards/${boardId}/interviews`, {
        questionId: "pastebin",
        durationMinutes: 30,
        participants: [{ userId: users.outsider.id, role: "candidate" }],
      });
    // Not opened yet: refused. As an observer (sees the summary): needs membership.
    expect((await assign()).status).toBe(400);
    expect(await linkTicket()).toBe("editor"); // opening the board records the visit
    expect(
      (
        await call("interviewer", "POST", `/boards/${boardId}/interviews`, {
          questionId: "pastebin",
          durationMinutes: 30,
          participants: [{ userId: users.outsider.id, role: "observer" }],
        })
      ).status,
    ).toBe(400);
    const started = await assign();
    expect(started.status).toBe(201);
    const id = interviewViewSchema.parse((started.body as { interview: unknown }).interview).state
      .interviewId;

    const client = ticketedClient(server, boardId, { token: tokens.outsider, shareToken });
    try {
      await waitFor(() => client.provider.getStatus() === "connected", "link candidate connected");
      expect((await call("interviewer", "POST", `/interviews/${id}/end`)).status).toBe(200);
      // Their socket is re-ticketed even though they have no role without the link.
      await waitFor(() => client.closeCodes.includes(4403), "link candidate re-ticketed");
      expect(await linkTicket()).toBe("viewer");
    } finally {
      client.provider.destroy();
    }
  });

  it("lets only interviewers change roles, the timer, hints and the ending", async () => {
    const boardId = await newBoard();
    const { state } = await start(boardId);
    const id = state.interviewId;
    for (const who of ["candidate", "observer", "outsider"] as const) {
      expect((await call(who, "POST", `/interviews/${id}/timer`, { action: "pause" })).status).toBe(
        403,
      );
      expect((await call(who, "POST", `/interviews/${id}/hints/0/reveal`)).status).toBe(403);
      expect((await call(who, "POST", `/interviews/${id}/end`)).status).toBe(403);
      expect(
        (await call(who, "PUT", `/interviews/${id}/participants`, { participants: [] })).status,
      ).toBe(403);
      expect((await call(who, "GET", `/interviews/${id}/notes`)).status).toBe(403);
      expect((await call(who, "GET", `/interviews/${id}/scorecard`)).status).toBe(403);
    }
    // Swapping roles: the observer becomes the candidate's co-interviewer.
    const changed = await call("interviewer", "PUT", `/interviews/${id}/participants`, {
      participants: [
        { userId: users.candidate.id, role: "candidate" },
        { userId: users.observer.id, role: "interviewer" },
      ],
    });
    expect(changed.status).toBe(200);
    expect(await ticketRole("observer", boardId)).toBe("editor");
    expect((await call("observer", "GET", `/interviews/${id}/notes`)).status).toBe(200);
  });
});

describe("timer, hints, notes, scorecards", () => {
  it("pauses, resumes and extends the countdown and reveals hints once", async () => {
    const boardId = await newBoard();
    const { state } = await start(boardId);
    const id = state.interviewId;
    const timer = async (body: unknown) => {
      const res = await call("interviewer", "POST", `/interviews/${id}/timer`, body);
      expect(res.status).toBe(200);
      return interviewViewSchema.parse((res.body as { interview: unknown }).interview).state;
    };
    const paused = await timer({ action: "pause" });
    expect(paused.timer.pausedAt).not.toBeNull();
    const left = remainingMs(paused.timer, paused.serverNow);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const again = await timer({ action: "pause" });
    expect(again.version).toBe(paused.version); // no-op
    expect(remainingMs(again.timer, again.serverNow + 10_000)).toBe(left); // frozen
    const resumed = await timer({ action: "resume" });
    expect(resumed.timer.pausedAt).toBeNull();
    expect(resumed.timer.pausedMs).toBeGreaterThanOrEqual(250);
    const extended = await timer({ action: "extend", minutes: 5 });
    expect(extended.timer.durationMs).toBe(35 * 60_000);

    const reveal = await call("interviewer", "POST", `/interviews/${id}/hints/1/reveal`);
    const revealed = interviewViewSchema.parse((reveal.body as { interview: unknown }).interview);
    expect(revealed.state.revealedHints.map((h) => h.index)).toEqual([1]);
    const repeat = await call("interviewer", "POST", `/interviews/${id}/hints/1/reveal`);
    expect(
      interviewViewSchema.parse((repeat.body as { interview: unknown }).interview).state.version,
    ).toBe(revealed.state.version);
    expect((await call("interviewer", "POST", `/interviews/${id}/hints/9/reveal`)).status).toBe(
      404,
    );

    // Nothing changes after the end.
    expect((await call("interviewer", "POST", `/interviews/${id}/end`)).status).toBe(200);
    expect(
      (await call("interviewer", "POST", `/interviews/${id}/timer`, { action: "pause" })).status,
    ).toBe(409);
  });

  it("keeps notes editable only by their author and scorecards per interviewer", async () => {
    const boardId = await newBoard();
    const { state } = await start(boardId);
    const id = state.interviewId;
    await call("interviewer", "PUT", `/interviews/${id}/participants`, {
      participants: [
        { userId: users.candidate.id, role: "candidate" },
        { userId: users.observer.id, role: "interviewer" },
      ],
    });
    const note = await call("interviewer", "POST", `/interviews/${id}/notes`, {
      body: "Asked about QPS",
    });
    const noteId = (note.body as { id: string }).id;
    expect(
      (await call("observer", "PATCH", `/interviews/${id}/notes/${noteId}`, { body: "x" })).status,
    ).toBe(403);
    expect((await call("observer", "DELETE", `/interviews/${id}/notes/${noteId}`)).status).toBe(
      403,
    );
    expect(
      (await call("interviewer", "POST", `/interviews/${id}/notes`, { body: "   " })).status,
    ).toBe(400);
    const list = await call("observer", "GET", `/interviews/${id}/notes`);
    expect((list.body as { notes: { body: string }[] }).notes.map((n) => n.body)).toEqual([
      "Asked about QPS",
    ]);

    const card = await call("interviewer", "PUT", `/interviews/${id}/scorecard`, {
      scores: {
        requirements: { score: 4, comment: "Great scoping" },
        scalability: { score: 2, comment: "" },
      },
      recommendation: "yes",
      summary: "Solid",
      submit: false,
    });
    expect(card.status).toBe(200);
    expect(
      (card.body as { scorecard: { submittedAt: string | null } }).scorecard.submittedAt,
    ).toBeNull();
    expect(
      (
        await call("interviewer", "PUT", `/interviews/${id}/scorecard`, {
          scores: { requirements: { score: 5, comment: "" } },
          recommendation: null,
          summary: "",
          submit: true,
        })
      ).status,
    ).toBe(400);
    const submitted = await call("interviewer", "PUT", `/interviews/${id}/scorecard`, {
      scores: { requirements: { score: 4, comment: "Great scoping" } },
      recommendation: "strong_yes",
      summary: "Solid",
      submit: true,
    });
    expect(
      (submitted.body as { scorecard: { submittedAt: string | null } }).scorecard.submittedAt,
    ).not.toBeNull();
    const theirs = await call("observer", "GET", `/interviews/${id}/scorecard`);
    expect((theirs.body as { scorecard: unknown }).scorecard).toBeNull();

    const audits = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.boardId, boardId));
    expect(audits.map((a) => a.action)).toContain("interview.scorecard_submit");
    expect(audits.map((a) => a.action)).toContain("interview.roles_change");
  });
});

describe("summary and share links", () => {
  it("shows notes only to interviewers and lets signed-in link holders read the rest", async () => {
    const boardId = await newBoard();
    const { state } = await start(boardId);
    const id = state.interviewId;
    await call("interviewer", "POST", `/interviews/${id}/notes`, { body: "Private observation" });
    await call("interviewer", "POST", `/interviews/${id}/end`);

    const mine = interviewSummarySchema.parse(
      (await call("interviewer", "GET", `/interviews/${id}/summary`)).body,
    );
    expect(mine.notes?.map((n) => n.body)).toEqual(["Private observation"]);
    expect(mine.canShare).toBe(true);
    expect(mine.question.hints.length).toBeGreaterThan(0);

    const observed = interviewSummarySchema.parse(
      (await call("observer", "GET", `/interviews/${id}/summary`)).body,
    );
    expect(observed.notes).toBeNull();
    expect(observed.canShare).toBe(false);

    expect((await call("outsider", "GET", `/interviews/${id}/summary`)).status).toBe(403);
    const link = await call("interviewer", "POST", `/interviews/${id}/share-links`);
    const token = (link.body as { token: string; id: string }).token;
    const viaLink = await server.request("GET", `/interviews/${id}/summary`, {
      token: tokens.outsider,
      headers: { "x-share-token": token },
    });
    expect(viaLink.status).toBe(200);
    expect(interviewSummarySchema.parse(viaLink.body).notes).toBeNull();
    // Signed out: always refused.
    expect(
      (
        await server.request("GET", `/interviews/${id}/summary`, {
          headers: { "x-share-token": token },
        })
      ).status,
    ).toBe(401);
    // Revoked: refused again.
    const linkId = (link.body as { id: string }).id;
    expect(
      (await call("interviewer", "DELETE", `/interviews/${id}/share-links/${linkId}`)).status,
    ).toBe(204);
    expect(
      (
        await server.request("GET", `/interviews/${id}/summary`, {
          token: tokens.outsider,
          headers: { "x-share-token": token },
        })
      ).status,
    ).toBe(403);
    const audits = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.boardId, boardId));
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(["interview_link.create", "interview_link.revoke"]),
    );
  });
});

describe("session replay", () => {
  it("reconstructs the board as it was at each moment, across a compaction", async () => {
    const boardId = await newBoard();
    const client = ticketedClient(server, boardId, { token: tokens.interviewer });
    const store = new BoardStore({ doc: client.doc, userId: users.interviewer.id });
    const repository = new PgBoardRepository(db);
    const saved = () => waitFor(() => client.provider.getSaveState() === "saved", "saved");
    /** Time (ms) of the newest stored update: the moment the current board became durable. */
    const storedAt = async () => {
      const [row] = await db.execute<{ t: string }>(dsql`
        select floor(extract(epoch from max(created_at)) * 1000)::bigint as t from (
          select created_at from board_updates where board_id = ${boardId}
          union all select created_at from board_update_archive where board_id = ${boardId}) h`);
      return Number(row?.t);
    };
    const shape = (id: string, x: number) => ({
      id,
      type: "rectangle" as const,
      x,
      y: 0,
      w: 100,
      h: 50,
      rotation: 0,
      zIndex: `a${id}`,
      style: {
        fill: "#ffffff",
        stroke: "#1f2937",
        strokeWidth: 2,
        strokeStyle: "solid" as const,
        fontSize: 16,
        opacity: 1,
      },
      groupId: null,
      createdBy: users.interviewer.id,
      updatedAt: 0,
      label: id,
    });
    try {
      await waitFor(() => client.provider.getStatus() === "connected", "connected");
      // Drawn before the interview: part of the base.
      store.createShape(shape("before", 0));
      await saved();
      const beforeStart = shapeRecords(client.doc);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const { state } = await start(boardId);

      const truth: [number, Record<string, unknown>][] = [];
      for (let i = 0; i < 12; i++) {
        if (i % 4 === 0) store.createShape(shape(`s${String(i)}`, i * 10));
        else if (i % 4 === 1)
          store.updateShape(`s${String(i - 1)}`, { x: i * 100, label: `moved ${String(i)}` });
        else if (i % 4 === 2) store.deleteShapes([`s${String(i - 2)}`]);
        else store.updateShape("before", { y: i * 5 });
        await saved();
        // "Saved" can precede the commit of a pure deletion (it doesn't advance the state
        // vector — see PROGRESS known issues); the flush window here is 10 ms.
        await new Promise((resolve) => setTimeout(resolve, 150));
        truth.push([await storedAt(), shapeRecords(client.doc)]);
        // Halfway: compaction moves the history so far into the archive and a snapshot.
        if (i === 5) expect(await repository.compact(boardId, buildSnapshot)).not.toBeNull();
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      expect(
        (await call("interviewer", "POST", `/interviews/${state.interviewId}/end`)).status,
      ).toBe(200);

      const res = await call("interviewer", "GET", `/interviews/${state.interviewId}/replay`);
      expect(res.status).toBe(200);
      const bundle = replayBundleSchema.parse(res.body);
      const timeline = new ReplayTimeline(
        fromBase64(bundle.base),
        bundle.frames.map((f) => ({ t: f.t, update: fromBase64(f.u) })),
        { start: bundle.startedAt, end: bundle.endedAt },
        3,
      );
      const base = timeline.docAt(bundle.startedAt - 1);
      expect(shapeRecords(base)).toEqual(beforeStart);
      base.destroy();
      for (const [t, expected] of truth) {
        const doc = timeline.docAt(t);
        expect(shapeRecords(doc), `board at ${String(t)}`).toEqual(expected);
        doc.destroy();
      }
      expect(bundle.markers.map((m) => m.kind)).toEqual(
        expect.arrayContaining(["started", "ended"]),
      );
      // The candidate can't replay; the observer can.
      expect(
        (await call("candidate", "GET", `/interviews/${state.interviewId}/replay`)).status,
      ).toBe(403);
      expect(
        (await call("observer", "GET", `/interviews/${state.interviewId}/replay`)).status,
      ).toBe(200);
      const [row] = await db
        .select({ status: interviews.status })
        .from(interviews)
        .where(eq(interviews.id, state.interviewId));
      expect(row?.status).toBe("ended");
    } finally {
      client.provider.destroy();
    }
  });
});

async function waitFor(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
