// Phase 8 acceptance: an interview's private data never reaches the candidate — not in any
// WebSocket frame their connection receives, and not in any REST response they can get.
// A real API + sync server on Postgres; single instance, then two instances over Redis.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { board } from "@whiteboard/graph/testing";
import {
  interviewViewResponseSchema,
  publicInterviewStateSchema,
  type PublicInterviewState,
} from "@whiteboard/shared/interview";
import { SYNC_SUBPROTOCOL, TICKET_PROTOCOL_PREFIX } from "@whiteboard/shared/sync";
import { boardMembers, entitlements, type Database, type SqlClient } from "@whiteboard/shared/db";
import { findQuestion } from "../src/interview/questionBank";
import { PgBoardRepository } from "../src/persistence/pgRepository";
import { RedisRevocationBus } from "../src/revocation/bus";
import { fakeAiConfig, FakeModel, finding, minimalReview, okJson, writeShapes } from "./aiHelpers";
import {
  createAuthUser,
  createOwnedBoard,
  createTestAuth,
  deleteAuthUsers,
  startApiServer,
  type ApiServer,
  type TestUser,
} from "./authHelpers";
import { connectTestRedis } from "./clusterHelpers";
import { silentLogger } from "./helpers";
import { connectTestDb } from "./pgHelpers";
import { ORIGIN } from "./syncHelpers";

const QUESTION_ID = "url-shortener";
function requireQuestion(id: string) {
  const found = findQuestion(id);
  if (!found) throw new Error("question bank is missing the test question");
  return found;
}
const question = requireQuestion(QUESTION_ID);

/** Unique strings that must never reach the candidate. */
const secret = (label: string) => `SECRET-${label}-${crypto.randomUUID()}`;

let db: Database;
let sql: SqlClient;
let auth: Awaited<ReturnType<typeof createTestAuth>>;
const model = new FakeModel();
const users = {} as Record<"interviewer" | "candidate" | "observer", TestUser>;
const tokens = {} as Record<keyof typeof users, string>;

/**
 * A raw WebSocket client that records every frame it receives, reconnecting with a fresh
 * ticket when the server closes it (e.g. when ending the interview changes its role), so it
 * sees everything the server ever sends to this user.
 */
class RecordingSocket {
  readonly frames: Buffer[] = [];
  readonly closes: number[] = [];
  /** Index into `frames` where the current connection's frames start. */
  private connectionStart = 0;
  connections = 0;
  private socket: WebSocket | null = null;
  private stopped = false;

  constructor(
    private readonly server: ApiServer,
    private readonly boardId: string,
    private readonly token: string,
  ) {}

  async connect(): Promise<void> {
    const res = await this.server.request("POST", `/boards/${this.boardId}/ticket`, {
      token: this.token,
      body: {},
    });
    expect(res.status).toBe(200);
    const { ticket } = res.body as { ticket: string };
    const ws = new WebSocket(
      `${this.server.wsUrl}/rooms/${this.boardId}`,
      [SYNC_SUBPROTOCOL, `${TICKET_PROTOCOL_PREFIX}${ticket}`],
      { origin: ORIGIN },
    );
    this.socket = ws;
    this.connections += 1;
    this.connectionStart = this.frames.length;
    ws.on("message", (data: Buffer) => this.frames.push(Buffer.from(data)));
    ws.on("error", () => undefined);
    ws.on("close", (code) => {
      this.closes.push(code);
      if (!this.stopped) void this.connect();
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => {
        resolve();
      });
      ws.once("error", reject);
    });
  }

  /** Every interview state received (message type 3), in order. */
  interviewStates(currentConnectionOnly = false): PublicInterviewState[] {
    return this.frames
      .slice(currentConnectionOnly ? this.connectionStart : 0)
      .filter((f) => f[0] === 3)
      .map((f) => {
        // varUint type (1 byte), then a varString: varUint length + UTF-8 JSON.
        let offset = 1;
        let length = 0;
        let shift = 0;
        for (;;) {
          const byte = f[offset++] ?? 0;
          length |= (byte & 0x7f) << shift;
          shift += 7;
          if (byte < 0x80) break;
        }
        return publicInterviewStateSchema.parse(
          JSON.parse(f.subarray(offset, offset + length).toString("utf8")),
        );
      });
  }

  /** Whether any frame contains `text` (UTF-8 or base64, as Yjs strings or JSON would). */
  saw(text: string): boolean {
    const utf8 = Buffer.from(text, "utf8");
    const b64 = Buffer.from(Buffer.from(text).toString("base64"));
    return this.frames.some((f) => f.includes(utf8) || f.includes(b64));
  }

  close(): void {
    this.stopped = true;
    this.socket?.close();
  }
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function setupBoard(): Promise<string> {
  const boardId = await createOwnedBoard(db, users.interviewer);
  await db.insert(boardMembers).values([
    { boardId, userId: users.candidate.id, role: "editor" },
    { boardId, userId: users.observer.id, role: "editor" },
  ]);
  const shapes = board()
    .add("client", "web", { label: "Browser" })
    .add("service", "api", { label: "Shortener API" })
    .add("database", "db", { label: "Links DB" })
    .arrow("web", "api", { id: "a1" })
    .arrow("api", "db", { id: "a2" })
    .build();
  await writeShapes(new PgBoardRepository(db), boardId, shapes);
  return boardId;
}

/**
 * Runs a whole interview against `api` (the interviewer's instance) while the candidate is
 * connected to `candidateServer`, and returns every secret that was written.
 */
async function runInterview(api: ApiServer, candidateServer: ApiServer, boardId: string) {
  const secrets = {
    note: secret("note"),
    editedNote: secret("edited-note"),
    deletedNote: secret("deleted-note"),
    scoreComment: secret("score-comment"),
    scoreSummary: secret("score-summary"),
    review: secret("review"),
  };
  const hidden = question.hints.slice(1);
  const revealed = question.hints[0] ?? "";
  const call = (method: string, path: string, body?: unknown) =>
    api.request(method, path, {
      token: tokens.interviewer,
      ...(body !== undefined ? { body } : {}),
    });

  const candidate = new RecordingSocket(candidateServer, boardId, tokens.candidate);
  await candidate.connect();

  const started = await call("POST", `/boards/${boardId}/interviews`, {
    questionId: QUESTION_ID,
    durationMinutes: 45,
    participants: [
      { userId: users.candidate.id, role: "candidate" },
      { userId: users.observer.id, role: "observer" },
    ],
  });
  expect(started.status).toBe(201);
  const interviewId = (started.body as { interview: { state: { interviewId: string } } }).interview
    .state.interviewId;
  await waitFor(() => candidate.interviewStates().length > 0, "the interview state");

  // Notes: create, edit, delete.
  const note = await call("POST", `/interviews/${interviewId}/notes`, { body: secrets.note });
  expect(note.status).toBe(201);
  const other = await call("POST", `/interviews/${interviewId}/notes`, { body: "tmp" });
  const otherId = (other.body as { id: string }).id;
  expect(
    (
      await call("PATCH", `/interviews/${interviewId}/notes/${otherId}`, {
        body: secrets.editedNote,
      })
    ).status,
  ).toBe(200);
  const third = await call("POST", `/interviews/${interviewId}/notes`, {
    body: secrets.deletedNote,
  });
  expect(
    (await call("DELETE", `/interviews/${interviewId}/notes/${(third.body as { id: string }).id}`))
      .status,
  ).toBe(204);

  // Timer changes and one revealed hint (the positive control: it must reach the candidate).
  expect((await call("POST", `/interviews/${interviewId}/timer`, { action: "pause" })).status).toBe(
    200,
  );
  expect(
    (await call("POST", `/interviews/${interviewId}/timer`, { action: "resume" })).status,
  ).toBe(200);
  expect(
    (await call("POST", `/interviews/${interviewId}/timer`, { action: "extend", minutes: 5 }))
      .status,
  ).toBe(200);
  expect((await call("POST", `/interviews/${interviewId}/hints/0/reveal`)).status).toBe(200);
  await waitFor(() => candidate.saw(revealed), "the revealed hint");

  // An AI review by the interviewer, whose text is a secret too.
  model.respond = () =>
    okJson({
      ...minimalReview([finding(["n2"], { title: secrets.review })]),
      summary: secrets.review,
    });
  const review = await fetch(`${api.url}/boards/${boardId}/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${tokens.interviewer}` },
    body: JSON.stringify({ problemStatement: question.prompt, requirements: "" }),
  });
  expect(review.status).toBe(200);
  expect(await review.text()).toContain(secrets.review);

  // Scorecard, role change round-trip, end.
  const scorecard = await call("PUT", `/interviews/${interviewId}/scorecard`, {
    scores: { requirements: { score: 3, comment: secrets.scoreComment } },
    recommendation: "yes",
    summary: secrets.scoreSummary,
    submit: true,
  });
  expect(scorecard.status).toBe(200);
  expect((await call("POST", `/interviews/${interviewId}/end`)).status).toBe(200);
  await waitFor(
    () => candidate.interviewStates().some((s) => s.status === "ended"),
    "the ended state",
  );
  // Ending caps the candidate at viewer: their socket is re-ticketed (4403) and reconnects.
  await waitFor(() => candidate.closes.includes(4403), "the candidate's re-ticket");
  // The reconnected socket gets the (ended) state again when it joins.
  await waitFor(
    () => candidate.connections >= 2 && candidate.interviewStates(true).length > 0,
    "the state after reconnecting",
  );

  return { interviewId, secrets, hidden, revealed, candidate };
}

/** Every REST route a candidate might try, with and without guessing ids. */
async function candidateRestResponses(api: ApiServer, boardId: string, interviewId: string) {
  const paths: [string, string, unknown?][] = [
    ["GET", "/interview-questions"],
    ["GET", `/boards/${boardId}/interview`],
    ["GET", `/interviews/${interviewId}/notes`],
    ["POST", `/interviews/${interviewId}/notes`, { body: "hi" }],
    ["GET", `/interviews/${interviewId}/scorecard`],
    [
      "PUT",
      `/interviews/${interviewId}/scorecard`,
      { scores: {}, recommendation: null, summary: "", submit: false },
    ],
    ["GET", `/interviews/${interviewId}/summary`],
    ["GET", `/interviews/${interviewId}/replay`],
    ["GET", `/interviews/${interviewId}/share-links`],
    ["POST", `/interviews/${interviewId}/share-links`],
    ["POST", `/interviews/${interviewId}/hints/1/reveal`],
    ["POST", `/interviews/${interviewId}/end`],
    ["GET", `/boards/${boardId}/reviews`],
    ["POST", `/boards/${boardId}/hints`, {}],
  ];
  const results: { path: string; status: number; text: string }[] = [];
  for (const [method, path, body] of paths) {
    const res = await api.request(method, path, {
      token: tokens.candidate,
      ...(body !== undefined ? { body } : {}),
    });
    results.push({ path: `${method} ${path}`, status: res.status, text: JSON.stringify(res.body) });
  }
  return results;
}

beforeAll(async () => {
  ({ db, sql } = await connectTestDb());
  auth = await createTestAuth();
  for (const who of ["interviewer", "candidate", "observer"] as const) {
    users[who] = await createAuthUser(sql, who);
    tokens[who] = await auth.sign(users[who]);
  }
  await db.insert(entitlements).values({ userId: users.interviewer.id, plan: "team" });
});

afterAll(async () => {
  await deleteAuthUsers(
    sql,
    Object.values(users).map((u) => u.id),
  );
  await sql.end();
});

describe("interview privacy (single instance)", () => {
  let server: ApiServer;
  beforeAll(async () => {
    server = await startApiServer(db, auth.verifier, { ai: fakeAiConfig(model) });
  });
  afterAll(async () => {
    await server.stop();
  });

  it("never sends notes, hidden hints, scorecards or interview reviews to the candidate", async () => {
    const boardId = await setupBoard();
    const { interviewId, secrets, hidden, revealed, candidate } = await runInterview(
      server,
      server,
      boardId,
    );
    try {
      // The candidate did receive the interview itself (proves frames were captured)…
      const states = candidate.interviewStates();
      expect(states.at(-1)?.status).toBe("ended");
      expect(candidate.saw(revealed)).toBe(true);
      expect(candidate.saw(question.title)).toBe(true);
      // …and none of the private data, in any frame.
      for (const value of [...Object.values(secrets), ...hidden])
        expect(candidate.saw(value), `candidate socket received "${value}"`).toBe(false);

      // Every REST route either refuses the candidate or returns only public data.
      const responses = await candidateRestResponses(server, boardId, interviewId);
      for (const { path, text } of responses)
        for (const value of [...Object.values(secrets), ...hidden])
          expect(text.includes(value), `${path} returned "${value}"`).toBe(false);
      const status = Object.fromEntries(responses.map((r) => [r.path, r.status]));
      expect(status[`GET /interviews/${interviewId}/notes`]).toBe(403);
      expect(status[`GET /interviews/${interviewId}/summary`]).toBe(403);
      expect(status[`GET /interviews/${interviewId}/replay`]).toBe(403);
      expect(status["GET /interview-questions"]).toBe(402);
      expect(status[`GET /boards/${boardId}/reviews`]).toBe(200);

      // The candidate's own view of the interview: public state, no question details.
      const view = interviewViewResponseSchema.parse(
        (await server.request("GET", `/boards/${boardId}/interview`, { token: tokens.candidate }))
          .body,
      );
      expect(view.interview?.myRole).toBe("candidate");
      expect(view.interview?.question).toBeNull();
    } finally {
      candidate.close();
    }
  });

  it("refuses the candidate a summary even with a share link", async () => {
    const boardId = await setupBoard();
    const { interviewId, candidate } = await runInterview(server, server, boardId);
    candidate.close();
    const link = await server.request("POST", `/interviews/${interviewId}/share-links`, {
      token: tokens.interviewer,
    });
    expect(link.status).toBe(201);
    const token = (link.body as { token: string }).token;
    const asCandidate = await server.request("GET", `/interviews/${interviewId}/summary`, {
      token: tokens.candidate,
      headers: { "x-share-token": token },
    });
    expect(asCandidate.status).toBe(403);
  });
});

describe("interview privacy (two instances over Redis)", () => {
  let a: ApiServer;
  let b: ApiServer;
  const buses: RedisRevocationBus[] = [];
  const redisClients: Awaited<ReturnType<typeof connectTestRedis>>[] = [];

  beforeAll(async () => {
    for (const name of ["a", "b"]) {
      const redis = await connectTestRedis();
      redisClients.push(redis);
      buses.push(
        new RedisRevocationBus(redis, silentLogger, `privacy-${name}-${crypto.randomUUID()}`),
      );
    }
    const [busA, busB] = buses;
    if (!busA || !busB) throw new Error("buses not created");
    a = await startApiServer(db, auth.verifier, { ai: fakeAiConfig(model), revocations: busA });
    b = await startApiServer(db, auth.verifier, { ai: fakeAiConfig(model), revocations: busB });
    // Let both subscriptions settle before publishing.
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  afterAll(async () => {
    await a.stop();
    await b.stop();
    for (const bus of buses) await bus.close();
    for (const redis of redisClients) redis.disconnect();
  });

  it("delivers public state across instances and nothing private", async () => {
    const boardId = await setupBoard();
    // The interviewer uses instance A; the candidate is connected to instance B.
    const { secrets, hidden, revealed, candidate } = await runInterview(a, b, boardId);
    try {
      expect(candidate.saw(revealed)).toBe(true);
      expect(candidate.interviewStates().at(-1)?.status).toBe("ended");
      for (const value of [...Object.values(secrets), ...hidden])
        expect(candidate.saw(value), `candidate socket received "${value}"`).toBe(false);
    } finally {
      candidate.close();
    }
  });
});
