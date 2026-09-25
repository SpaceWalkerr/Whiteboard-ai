import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  aiReviewSchema,
  designGraphSchema,
  findingSchema,
  reviewRecordSchema,
  type InterviewSummary,
  type ReviewRecord,
} from "@whiteboard/graph";
import {
  interviewNoteSchema,
  noteBodySchema,
  scorecardInputSchema,
  scorecardSchema,
  startInterviewSchema,
  timerActionSchema,
  updateParticipantsSchema,
  type InterviewNote,
  type InterviewQuestion,
  type InterviewRole,
  type InterviewView,
  type ReplayBundle,
  type ReplayMarker,
  type Scorecard,
} from "@whiteboard/shared/interview";
import { toBase64 } from "@whiteboard/shared/replay";
import {
  and,
  asc,
  boards,
  boardVisits,
  desc,
  eq,
  interviewEvents,
  interviewNotes,
  interviewParticipants,
  interviews,
  interviewScorecards,
  interviewShareLinks,
  profiles,
  reviews,
  sql,
  type PgUpdateSetSource,
} from "@whiteboard/shared/db";
import { hashToken, resolveBoardAccess } from "../access/boardAccess";
import { getEntitlement } from "../ai/entitlements";
import { audit } from "../audit/audit";
import { requireUser } from "../auth/requestAuth";
import type { AuthUser } from "../auth/verifier";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PaymentRequiredError,
} from "../errors";
import { QUESTION_BANK, findQuestion } from "../interview/questionBank";
import { encodeFrames, loadReplayHistory } from "../interview/replay";
import {
  findInterview,
  interviewRoleOf,
  latestInterview,
  participantsOf,
  questionOf,
  timerOf,
  toPublicState,
  type InterviewRow,
} from "../interview/service";
import { authorize, shareTokenOf } from "./boards";
import type { ApiDeps, Tx } from "./deps";
import { parse } from "./validation";

const boardParams = z.object({ id: z.uuid() });
const interviewParams = z.object({ id: z.uuid() });
const noteParams = z.object({ id: z.uuid(), noteId: z.uuid() });
const hintParams = z.object({ id: z.uuid(), index: z.coerce.number().int().min(0).max(20) });
const linkParams = z.object({ id: z.uuid(), linkId: z.uuid() });

const PLAN_REQUIRED_MESSAGE = "Interview mode is included in the Team plan.";

/**
 * Interview mode (Team plan). Every route checks the caller's interview role; private data
 * (notes, hints not yet revealed, scorecards, interview reviews) is returned only to the roles
 * listed on each route and never to the candidate. Live updates to participants go out as a
 * public-state broadcast (see sync/upgrade.ts), never with private content.
 */
export function registerInterviewRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { db } = deps;

  async function requireTeamPlan(userId: string): Promise<void> {
    const entitlement = await getEntitlement(db, userId);
    if (!entitlement.interviewMode)
      throw new PaymentRequiredError("PLAN_REQUIRED", PLAN_REQUIRED_MESSAGE);
  }

  /** Loads an interview and checks the caller has one of `roles` in it (else 404/403). */
  async function requireRole(
    interviewId: string,
    userId: string,
    roles: readonly InterviewRole[],
  ): Promise<{ interview: InterviewRow; role: InterviewRole }> {
    const interview = await findInterview(db, interviewId);
    if (!interview) throw new NotFoundError("Interview not found");
    const role = await interviewRoleOf(db, interviewId, userId);
    if (role === null) {
      // Not a participant: say nothing about the interview beyond "no access".
      throw new ForbiddenError("You don't have access to this interview.");
    }
    if (!roles.includes(role)) throw new ForbiddenError();
    return { interview, role };
  }

  function requireActive(interview: InterviewRow): void {
    if (interview.status !== "active") throw new ConflictError("This interview has ended.");
  }

  /**
   * Who may open the summary and replay: interviewers and observers, and signed-in holders of
   * a summary link — but never the candidate, whatever they hold.
   */
  async function summaryAccess(
    request: FastifyRequest,
    interviewId: string,
  ): Promise<{ interview: InterviewRow; role: InterviewRole | null; user: AuthUser }> {
    const user = requireUser(request);
    const interview = await findInterview(db, interviewId);
    if (!interview) throw new NotFoundError("Interview not found");
    const role = await interviewRoleOf(db, interviewId, user.id);
    if (role === "candidate") throw new ForbiddenError("You don't have access to this interview.");
    if (role === "interviewer" || role === "observer") return { interview, role, user };
    const token = shareTokenOf(request);
    if (token !== undefined) {
      const [link] = await db
        .select({ id: interviewShareLinks.id })
        .from(interviewShareLinks)
        .where(
          and(
            eq(interviewShareLinks.interviewId, interviewId),
            eq(interviewShareLinks.tokenHash, hashToken(token)),
            sql`${interviewShareLinks.revokedAt} is null`,
          ),
        );
      if (link) return { interview, role: null, user };
    }
    throw new ForbiddenError("You don't have access to this interview.");
  }

  /**
   * Validates a participant list. Interviewers and observers see private data (notes, the
   * summary), so they need access to the board as members (or through the workspace). A
   * candidate only gets restricted, and usually joins through a share link (not a member):
   * having opened the board — recorded only after the ticket route authorized them — is
   * enough. The caller (already authorized for this request) is always an interviewer.
   */
  async function checkParticipants(
    boardId: string,
    callerId: string,
    list: { userId: string; role: InterviewRole }[],
  ): Promise<{ userId: string; role: InterviewRole }[]> {
    const others = list.filter((p) => p.userId !== callerId);
    for (const participant of others) {
      const access = await resolveBoardAccess(db, boardId, { userId: participant.userId });
      if ((access?.role ?? null) !== null) continue;
      if (participant.role === "candidate" && (await hasOpened(boardId, participant.userId)))
        continue;
      throw new BadRequestError(
        participant.role === "candidate"
          ? "The candidate must open the board (share it with them) before the interview."
          : "Interviewers and observers must be members of the board — invite them by email first.",
      );
    }
    return [{ userId: callerId, role: "interviewer" as const }, ...others];
  }

  async function hasOpened(boardId: string, userId: string): Promise<boolean> {
    const [visit] = await db
      .select({ at: boardVisits.lastOpenedAt })
      .from(boardVisits)
      .where(and(eq(boardVisits.boardId, boardId), eq(boardVisits.userId, userId)));
    return visit !== undefined;
  }

  /**
   * After a change: tell every instance, and re-ticket the sockets of everyone whose read-only
   * cap may have changed — candidates and observers, before and after (interviewers are never
   * capped). A socket re-tickets within milliseconds and gets its new role. This can't compare
   * roles instead: people who joined through a share link have no role without their link.
   */
  async function announce(
    boardId: string,
    affected: readonly { userId: string; role: InterviewRole }[],
  ): Promise<void> {
    const userIds = new Set(affected.filter((p) => p.role !== "interviewer").map((p) => p.userId));
    for (const userId of userIds)
      await deps.revocations.publish({ type: "member", boardId, userId });
    await deps.revocations.publish({ type: "interview", boardId });
  }

  async function recordEvent(
    tx: Tx,
    interviewId: string,
    kind: string,
    actorId: string,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    await tx.insert(interviewEvents).values({ interviewId, kind, actorId, data });
  }

  /** Bumps the version (what participants see changed) inside the caller's transaction. */
  async function bump(tx: Tx, interviewId: string, set: PgUpdateSetSource<typeof interviews> = {}) {
    const [row] = await tx
      .update(interviews)
      .set({ ...set, version: sql`${interviews.version} + 1` })
      .where(eq(interviews.id, interviewId))
      .returning();
    if (!row) throw new NotFoundError("Interview not found");
    return row;
  }

  async function view(row: InterviewRow, userId: string): Promise<InterviewView> {
    const myRole = await interviewRoleOf(db, row.id, userId);
    return {
      state: toPublicState(row, await participantsOf(db, row.id)),
      myRole,
      question: myRole === "interviewer" ? questionOf(row) : null,
    };
  }

  // ── Question bank ────────────────────────────────────────────────────────────────────────

  app.get("/interview-questions", async (request): Promise<{ questions: InterviewQuestion[] }> => {
    const user = requireUser(request);
    await requireTeamPlan(user.id);
    return { questions: [...QUESTION_BANK] };
  });

  // ── Lifecycle ────────────────────────────────────────────────────────────────────────────

  app.get(
    "/boards/:id/interview",
    async (request): Promise<{ interview: InterviewView | null }> => {
      const user = requireUser(request);
      const { id } = parse(boardParams, request.params);
      await authorize(deps, id, user.id, "read", { shareToken: shareTokenOf(request) });
      const row = await latestInterview(db, id);
      return { interview: row ? await view(row, user.id) : null };
    },
  );

  app.post("/boards/:id/interviews", async (request, reply) => {
    const user = requireUser(request);
    const { id } = parse(boardParams, request.params);
    const body = parse(startInterviewSchema, request.body);
    const access = await authorize(deps, id, user.id, "write", {
      shareToken: shareTokenOf(request),
    });
    await requireTeamPlan(user.id);
    const question = findQuestion(body.questionId);
    if (!question) throw new BadRequestError("Unknown question.");
    const participants = await checkParticipants(id, user.id, body.participants);

    let row: InterviewRow;
    try {
      row = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(interviews)
          .values({
            boardId: id,
            startedBy: user.id,
            question,
            durationMs: body.durationMinutes * 60_000,
          })
          .returning();
        if (!created) throw new Error("interview insert failed");
        await tx
          .insert(interviewParticipants)
          .values(participants.map((p) => ({ interviewId: created.id, ...p })));
        await recordEvent(tx, created.id, "started", user.id, { questionId: question.id });
        await audit(tx, {
          action: "interview.start",
          actorId: user.id,
          orgId: access.orgId,
          boardId: id,
          targetType: "interview",
          targetId: created.id,
          metadata: { questionId: question.id, participants },
          ip: request.ip,
        });
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictError("An interview is already running on this board.");
      throw error;
    }
    await announce(id, participants);
    return reply.status(201).send({ interview: await view(row, user.id) });
  });

  app.put("/interviews/:id/participants", async (request) => {
    const user = requireUser(request);
    const { id } = parse(interviewParams, request.params);
    const body = parse(updateParticipantsSchema, request.body);
    const { interview } = await requireRole(id, user.id, ["interviewer"]);
    requireActive(interview);
    const participants = await checkParticipants(interview.boardId, user.id, body.participants);
    const previous = await participantsOf(db, id);
    const row = await db.transaction(async (tx) => {
      await tx.delete(interviewParticipants).where(eq(interviewParticipants.interviewId, id));
      await tx
        .insert(interviewParticipants)
        .values(participants.map((p) => ({ interviewId: id, ...p })));
      await audit(tx, {
        action: "interview.roles_change",
        actorId: user.id,
        boardId: interview.boardId,
        targetType: "interview",
        targetId: id,
        metadata: { participants },
        ip: request.ip,
      });
      return bump(tx, id);
    });
    await announce(interview.boardId, [...previous, ...participants]);
    return { interview: await view(row, user.id) };
  });

  app.post("/interviews/:id/timer", async (request) => {
    const user = requireUser(request);
    const { id } = parse(interviewParams, request.params);
    const action = parse(timerActionSchema, request.body);
    const { interview } = await requireRole(id, user.id, ["interviewer"]);
    requireActive(interview);
    const row = await db.transaction(async (tx) => {
      // Timestamps come from the database clock, like started_at, so they are consistent.
      switch (action.action) {
        case "pause":
          if (interview.pausedAt !== null) return interview;
          await recordEvent(tx, id, "timer_paused", user.id);
          return bump(tx, id, { pausedAt: sql`now()` });
        case "resume":
          if (interview.pausedAt === null) return interview;
          await recordEvent(tx, id, "timer_resumed", user.id);
          return bump(tx, id, {
            pausedMs: sql`${interviews.pausedMs} + (extract(epoch from now() - ${interviews.pausedAt}) * 1000)::bigint`,
            pausedAt: null,
          });
        case "extend":
          await recordEvent(tx, id, "timer_extended", user.id, { minutes: action.minutes });
          return bump(tx, id, {
            durationMs: sql`${interviews.durationMs} + ${action.minutes * 60_000}`,
          });
      }
    });
    if (row !== interview)
      await deps.revocations.publish({ type: "interview", boardId: row.boardId });
    return { interview: await view(row, user.id) };
  });

  app.post("/interviews/:id/hints/:index/reveal", async (request) => {
    const user = requireUser(request);
    const { id, index } = parse(hintParams, request.params);
    const { interview } = await requireRole(id, user.id, ["interviewer"]);
    requireActive(interview);
    if (index >= questionOf(interview).hints.length) throw new NotFoundError("Hint not found");
    let row = interview;
    if (!interview.revealedHints.includes(index)) {
      row = await db.transaction(async (tx) => {
        await recordEvent(tx, id, "hint_revealed", user.id, { index });
        return bump(tx, id, { revealedHints: [...interview.revealedHints, index] });
      });
      await deps.revocations.publish({ type: "interview", boardId: row.boardId });
    }
    return { interview: await view(row, user.id) };
  });

  app.post("/interviews/:id/end", async (request) => {
    const user = requireUser(request);
    const { id } = parse(interviewParams, request.params);
    const { interview } = await requireRole(id, user.id, ["interviewer"]);
    if (interview.status === "ended") return { interview: await view(interview, user.id) };
    const participants = await participantsOf(db, id);
    const row = await db.transaction(async (tx) => {
      await recordEvent(tx, id, "ended", user.id);
      await audit(tx, {
        action: "interview.end",
        actorId: user.id,
        boardId: interview.boardId,
        targetType: "interview",
        targetId: id,
        ip: request.ip,
      });
      // A pause still open at the end counts as paused time.
      return bump(tx, id, {
        status: "ended",
        endedAt: sql`now()`,
        pausedMs: sql`${interviews.pausedMs} + coalesce((extract(epoch from now() - ${interviews.pausedAt}) * 1000)::bigint, 0)`,
        pausedAt: null,
      });
    });
    await announce(interview.boardId, participants);
    return { interview: await view(row, user.id) };
  });

  // ── Private notes (interviewers only) ──────────────────────────────────────────────────────

  const noteColumns = {
    id: interviewNotes.id,
    authorId: interviewNotes.authorId,
    body: interviewNotes.body,
    createdAt: interviewNotes.createdAt,
    updatedAt: interviewNotes.updatedAt,
    name: profiles.displayName,
    email: profiles.email,
  };
  interface NoteRow {
    id: string;
    authorId: string | null;
    body: string;
    createdAt: Date;
    updatedAt: Date;
    name: string | null;
    email: string | null;
  }
  const toNote = (r: NoteRow): InterviewNote =>
    interviewNoteSchema.parse({
      id: r.id,
      authorId: r.authorId,
      authorName: r.name ?? r.email ?? "Unknown user",
      body: r.body,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    });

  async function listNotes(interviewId: string): Promise<InterviewNote[]> {
    const rows = await db
      .select(noteColumns)
      .from(interviewNotes)
      .leftJoin(profiles, eq(profiles.id, interviewNotes.authorId))
      .where(eq(interviewNotes.interviewId, interviewId))
      .orderBy(asc(interviewNotes.createdAt));
    return rows.map(toNote);
  }

  async function getNote(interviewId: string, noteId: string): Promise<InterviewNote> {
    const [row] = await db
      .select(noteColumns)
      .from(interviewNotes)
      .leftJoin(profiles, eq(profiles.id, interviewNotes.authorId))
      .where(and(eq(interviewNotes.id, noteId), eq(interviewNotes.interviewId, interviewId)));
    if (!row) throw new NotFoundError("Note not found");
    return toNote(row);
  }

  app.get("/interviews/:id/notes", async (request) => {
    const user = requireUser(request);
    const { id } = parse(interviewParams, request.params);
    await requireRole(id, user.id, ["interviewer"]);
    return { notes: await listNotes(id) };
  });

  app.post("/interviews/:id/notes", async (request, reply) => {
    const user = requireUser(request);
    const { id } = parse(interviewParams, request.params);
    const { body } = parse(noteBodySchema, request.body);
    await requireRole(id, user.id, ["interviewer"]);
    const [row] = await db
      .insert(interviewNotes)
      .values({ interviewId: id, authorId: user.id, body })
      .returning({ id: interviewNotes.id });
    if (!row) throw new Error("note insert failed");
    return reply.status(201).send(await getNote(id, row.id));
  });

  /** Only the author may change or delete a note. */
  async function requireOwnNote(interviewId: string, noteId: string, userId: string) {
    await requireRole(interviewId, userId, ["interviewer"]);
    const note = await getNote(interviewId, noteId);
    if (note.authorId !== userId) throw new ForbiddenError("You can only change your own notes.");
  }

  app.patch("/interviews/:id/notes/:noteId", async (request) => {
    const user = requireUser(request);
    const { id, noteId } = parse(noteParams, request.params);
    const { body } = parse(noteBodySchema, request.body);
    await requireOwnNote(id, noteId, user.id);
    await db
      .update(interviewNotes)
      .set({ body, updatedAt: new Date() })
      .where(eq(interviewNotes.id, noteId));
    return getNote(id, noteId);
  });

  app.delete("/interviews/:id/notes/:noteId", async (request, reply) => {
    const user = requireUser(request);
    const { id, noteId } = parse(noteParams, request.params);
    await requireOwnNote(id, noteId, user.id);
    await db.delete(interviewNotes).where(eq(interviewNotes.id, noteId));
    return reply.status(204).send();
  });

  // ── Scorecards (interviewers only) ─────────────────────────────────────────────────────────

  async function listScorecards(interviewId: string): Promise<Scorecard[]> {
    const rows = await db
      .select({
        interviewerId: interviewScorecards.interviewerId,
        scores: interviewScorecards.scores,
        recommendation: interviewScorecards.recommendation,
        summary: interviewScorecards.summary,
        submittedAt: interviewScorecards.submittedAt,
        updatedAt: interviewScorecards.updatedAt,
        name: profiles.displayName,
        email: profiles.email,
      })
      .from(interviewScorecards)
      .leftJoin(profiles, eq(profiles.id, interviewScorecards.interviewerId))
      .where(eq(interviewScorecards.interviewId, interviewId))
      .orderBy(asc(interviewScorecards.updatedAt));
    return rows.map((r) =>
      scorecardSchema.parse({
        interviewerId: r.interviewerId,
        interviewerName: r.name ?? r.email ?? "Unknown user",
        scores: r.scores,
        recommendation: r.recommendation,
        summary: r.summary,
        submittedAt: r.submittedAt?.toISOString() ?? null,
        updatedAt: r.updatedAt.toISOString(),
      }),
    );
  }

  app.get("/interviews/:id/scorecard", async (request) => {
    const user = requireUser(request);
    const { id } = parse(interviewParams, request.params);
    await requireRole(id, user.id, ["interviewer"]);
    const mine = (await listScorecards(id)).find((s) => s.interviewerId === user.id) ?? null;
    return { scorecard: mine };
  });

  app.put("/interviews/:id/scorecard", async (request) => {
    const user = requireUser(request);
    const { id } = parse(interviewParams, request.params);
    const input = parse(scorecardInputSchema, request.body);
    const { interview } = await requireRole(id, user.id, ["interviewer"]);
    await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ submittedAt: interviewScorecards.submittedAt })
        .from(interviewScorecards)
        .where(
          and(
            eq(interviewScorecards.interviewId, id),
            eq(interviewScorecards.interviewerId, user.id),
          ),
        );
      const values = {
        scores: input.scores,
        recommendation: input.recommendation,
        summary: input.summary,
        submittedAt: input.submit ? new Date() : (existing?.submittedAt ?? null),
        updatedAt: new Date(),
      };
      await tx
        .insert(interviewScorecards)
        .values({ interviewId: id, interviewerId: user.id, ...values })
        .onConflictDoUpdate({
          target: [interviewScorecards.interviewId, interviewScorecards.interviewerId],
          set: values,
        });
      if (input.submit)
        await audit(tx, {
          action: "interview.scorecard_submit",
          actorId: user.id,
          boardId: interview.boardId,
          targetType: "interview",
          targetId: id,
          metadata: { recommendation: input.recommendation },
          ip: request.ip,
        });
    });
    const mine = (await listScorecards(id)).find((s) => s.interviewerId === user.id) ?? null;
    return { scorecard: mine };
  });

  // ── Summary, sharing, replay ───────────────────────────────────────────────────────────────

  async function interviewReviews(interviewId: string): Promise<ReviewRecord[]> {
    const rows = await db
      .select({
        id: reviews.id,
        boardId: reviews.boardId,
        status: reviews.status,
        requestedBy: reviews.requestedBy,
        requesterName: profiles.displayName,
        requesterEmail: profiles.email,
        problemStatement: reviews.problemStatement,
        requirements: reviews.requirements,
        model: reviews.model,
        createdAt: reviews.createdAt,
        completedAt: reviews.completedAt,
        errorCode: reviews.errorCode,
        result: reviews.result,
        graph: reviews.graph,
        ruleFindings: reviews.ruleFindings,
      })
      .from(reviews)
      .leftJoin(profiles, eq(profiles.id, reviews.requestedBy))
      .where(and(eq(reviews.interviewId, interviewId), eq(reviews.status, "completed")))
      .orderBy(desc(reviews.createdAt))
      .limit(10);
    return rows.map((row) =>
      reviewRecordSchema.parse({
        id: row.id,
        boardId: row.boardId,
        status: row.status,
        requestedBy:
          row.requestedBy === null
            ? null
            : {
                id: row.requestedBy,
                name: row.requesterName ?? row.requesterEmail ?? "Unknown user",
              },
        problemStatement: row.problemStatement,
        requirements: row.requirements,
        model: row.model,
        createdAt: row.createdAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
        errorCode: row.errorCode,
        review: row.result === null ? null : aiReviewSchema.parse(row.result),
        graph: designGraphSchema.parse(row.graph),
        ruleFindings: z.array(findingSchema).parse(row.ruleFindings),
      }),
    );
  }

  app.get("/interviews/:id/summary", async (request): Promise<InterviewSummary> => {
    const { id } = parse(interviewParams, request.params);
    const { interview, role } = await summaryAccess(request, id);
    const [board] = await db
      .select({ title: boards.title })
      .from(boards)
      .where(eq(boards.id, interview.boardId));
    const [starter] = interview.startedBy
      ? await db
          .select({ name: profiles.displayName, email: profiles.email })
          .from(profiles)
          .where(eq(profiles.id, interview.startedBy))
      : [];
    return {
      interviewId: interview.id,
      boardId: interview.boardId,
      boardTitle: board?.title ?? "Untitled board",
      status: interview.status,
      question: questionOf(interview),
      revealedHints: interview.revealedHints,
      timer: timerOf(interview),
      participants: await participantsOf(db, id),
      startedByName: starter?.name ?? starter?.email ?? "Unknown user",
      myRole: role,
      scorecards: await listScorecards(id),
      notes: role === "interviewer" ? await listNotes(id) : null,
      canShare: role === "interviewer",
      reviews: await interviewReviews(id),
    };
  });

  app.get("/interviews/:id/share-links", async (request) => {
    const user = requireUser(request);
    const { id } = parse(interviewParams, request.params);
    await requireRole(id, user.id, ["interviewer"]);
    const rows = await db
      .select({ id: interviewShareLinks.id, createdAt: interviewShareLinks.createdAt })
      .from(interviewShareLinks)
      .where(
        and(eq(interviewShareLinks.interviewId, id), sql`${interviewShareLinks.revokedAt} is null`),
      )
      .orderBy(desc(interviewShareLinks.createdAt));
    return { links: rows.map((r) => ({ id: r.id, createdAt: r.createdAt.toISOString() })) };
  });

  app.post(
    "/interviews/:id/share-links",
    { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const user = requireUser(request);
      const { id } = parse(interviewParams, request.params);
      const { interview } = await requireRole(id, user.id, ["interviewer"]);
      const token = randomBytes(24).toString("base64url");
      const link = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(interviewShareLinks)
          .values({ interviewId: id, tokenHash: hashToken(token), createdBy: user.id })
          .returning({ id: interviewShareLinks.id, createdAt: interviewShareLinks.createdAt });
        if (!created) throw new Error("share link insert failed");
        await audit(tx, {
          action: "interview_link.create",
          actorId: user.id,
          boardId: interview.boardId,
          targetType: "interview_link",
          targetId: created.id,
          metadata: { interviewId: id },
          ip: request.ip,
        });
        return created;
      });
      return reply
        .status(201)
        .send({ id: link.id, createdAt: link.createdAt.toISOString(), token });
    },
  );

  app.delete("/interviews/:id/share-links/:linkId", async (request, reply) => {
    const user = requireUser(request);
    const { id, linkId } = parse(linkParams, request.params);
    const { interview } = await requireRole(id, user.id, ["interviewer"]);
    await db.transaction(async (tx) => {
      const revoked = await tx
        .update(interviewShareLinks)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(interviewShareLinks.id, linkId),
            eq(interviewShareLinks.interviewId, id),
            sql`${interviewShareLinks.revokedAt} is null`,
          ),
        )
        .returning({ id: interviewShareLinks.id });
      if (revoked.length === 0) throw new NotFoundError("Link not found");
      await audit(tx, {
        action: "interview_link.revoke",
        actorId: user.id,
        boardId: interview.boardId,
        targetType: "interview_link",
        targetId: linkId,
        metadata: { interviewId: id },
        ip: request.ip,
      });
    });
    return reply.status(204).send();
  });

  app.get("/interviews/:id/replay", async (request): Promise<ReplayBundle> => {
    const { id } = parse(interviewParams, request.params);
    const { interview, role } = await summaryAccess(request, id);
    const to = interview.endedAt ?? new Date();
    const history = await loadReplayHistory(db, interview.boardId, interview.startedAt, to);
    return {
      interviewId: id,
      startedAt: interview.startedAt.getTime(),
      endedAt: to.getTime(),
      base: toBase64(history.base),
      frames: encodeFrames(history.frames),
      markers: await replayMarkers(interview, role === "interviewer"),
    };
  });

  async function replayMarkers(
    interview: InterviewRow,
    includeNotes: boolean,
  ): Promise<ReplayMarker[]> {
    const markers: ReplayMarker[] = [];
    const events = await db
      .select()
      .from(interviewEvents)
      .where(eq(interviewEvents.interviewId, interview.id));
    for (const event of events) {
      const at = event.createdAt.getTime();
      switch (event.kind) {
        case "started":
        case "ended":
          markers.push({
            kind: event.kind,
            at,
            label: event.kind === "started" ? "Interview started" : "Interview ended",
            refId: null,
          });
          break;
        case "hint_revealed": {
          const index = typeof event.data.index === "number" ? event.data.index : -1;
          markers.push({
            kind: "hint_revealed",
            at,
            label: `Hint ${String(index + 1)} revealed`,
            refId: null,
          });
          break;
        }
        case "timer_paused":
          markers.push({ kind: "timer_paused", at, label: "Timer paused", refId: null });
          break;
        case "timer_resumed":
          markers.push({ kind: "timer_resumed", at, label: "Timer resumed", refId: null });
          break;
        case "timer_extended": {
          const minutes = typeof event.data.minutes === "number" ? event.data.minutes : 0;
          markers.push({
            kind: "timer_extended",
            at,
            label: `Timer extended by ${String(minutes)} min`,
            refId: null,
          });
          break;
        }
      }
    }
    const reviewRows = await db
      .select({
        id: reviews.id,
        status: reviews.status,
        createdAt: reviews.createdAt,
        completedAt: reviews.completedAt,
      })
      .from(reviews)
      .where(eq(reviews.interviewId, interview.id));
    for (const review of reviewRows) {
      markers.push({
        kind: "review_started",
        at: review.createdAt.getTime(),
        label: "AI review started",
        refId: review.id,
      });
      if (review.status === "completed" && review.completedAt)
        markers.push({
          kind: "review_completed",
          at: review.completedAt.getTime(),
          label: "AI review finished",
          refId: review.id,
        });
    }
    if (includeNotes) {
      for (const note of await listNotes(interview.id))
        markers.push({
          kind: "note",
          at: Date.parse(note.createdAt),
          label: `Note by ${note.authorName}: ${truncate(note.body, 80)}`,
          refId: note.id,
        });
    }
    return markers.sort((a, b) => a.at - b.at);
  }
}

function truncate(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  while (typeof current === "object" && current !== null) {
    if ("code" in current && current.code === "23505") return true;
    current = "cause" in current ? current.cause : null;
  }
  return false;
}

/**
 * For the review routes: the active interview on a board and the caller's role in it. During
 * an interview only interviewers and observers may run or see its AI reviews.
 */
export async function activeInterviewContext(
  deps: Pick<ApiDeps, "db">,
  boardId: string,
  userId: string,
): Promise<{ interviewId: string; role: InterviewRole | null } | null> {
  const [row] = await deps.db
    .select({ id: interviews.id })
    .from(interviews)
    .where(and(eq(interviews.boardId, boardId), eq(interviews.status, "active")));
  if (!row) return null;
  return { interviewId: row.id, role: await interviewRoleOf(deps.db, row.id, userId) };
}
