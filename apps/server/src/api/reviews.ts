import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  aiReviewSchema,
  designGraphSchema,
  findingSchema,
  GRAPH_FORMAT_VERSION,
  graphFingerprint,
  overallScore,
  reviewRecordSchema,
  reviewRequestSchema,
  runRules,
  type DesignCheckResult,
  type HintsResponse,
  type ReviewRecord,
  type ReviewStreamEvent,
  type ReviewSummary,
} from "@whiteboard/graph";
import type { AiQuota } from "@whiteboard/shared/api";
import {
  aiUsage,
  and,
  count,
  desc,
  eq,
  gt,
  interviewParticipants,
  profiles,
  reviews,
  sql,
  type AiCallStatus,
} from "@whiteboard/shared/db";
import { graphSize, loadDesign } from "../ai/boardGraph";
import { getEntitlement, quotaResetsAt, reserveReview, reviewsUsed } from "../ai/entitlements";
import type { LanguageModel } from "../ai/model";
import { runHints, runReview, type CallOutcome } from "../ai/reviewer";
import { recordUsage, spendTodayMicros } from "../ai/usage";
import { requireUser } from "../auth/requestAuth";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnprocessableError,
} from "../errors";
import { authorize, refuseIfPrivate, shareTokenOf } from "./boards";
import { activeInterviewContext } from "./interviews";
import { nowOf, type AiConfig, type ApiDeps } from "./deps";
import { checkFeature } from "@whiteboard/shared/entitlements";
import { throwIfBlocked } from "../billing/limits";
import { parse } from "./validation";

const idParams = z.object({ id: z.uuid() });
const reviewParams = z.object({ id: z.uuid(), reviewId: z.uuid() });

/** Live hints need at least this many components to say anything useful. */
const HINT_MIN_COMPONENTS = 3;
const PROGRESS_INTERVAL_MS = 500;
const HEARTBEAT_MS = 15_000;
/** Review requests may carry a private board's graph: more than the 256 kB default. */
const GRAPH_BODY_LIMIT = 1024 * 1024;

/** User-safe messages for failed reviews. None of these count toward the quota. */
const FAILURE_MESSAGES: Partial<Record<AiCallStatus, { code: string; message: string }>> = {
  error: {
    code: "AI_ERROR",
    message:
      "The AI review couldn't be completed. It didn't count toward your quota — please try again.",
  },
  refused: {
    code: "AI_REFUSED",
    message: "The AI declined to review this board. It didn't count toward your quota.",
  },
  truncated: {
    code: "AI_TRUNCATED",
    message:
      "The review ran too long to finish. It didn't count toward your quota — please try again.",
  },
  invalid_output: {
    code: "AI_INVALID_OUTPUT",
    message:
      "The AI returned an unusable review. It didn't count toward your quota — please try again.",
  },
};

/** Monthly quota, AI switch and spend kill-switch: everything checked before calling Claude. */
async function isSpendLimitReached(deps: ApiDeps, ai: AiConfig): Promise<boolean> {
  const spent = await spendTodayMicros(deps.db);
  return spent >= ai.dailySpendLimitUsd * 1_000_000;
}

async function requireAi(deps: ApiDeps): Promise<{ ai: AiConfig; llm: LanguageModel }> {
  const ai = deps.ai;
  if (!ai?.model)
    throw new ServiceUnavailableError("AI_UNAVAILABLE", "AI reviews aren't available right now.");
  if (!ai.enabled)
    throw new ServiceUnavailableError(
      "AI_DISABLED",
      "AI features are switched off right now. Please try again later.",
    );
  if (await isSpendLimitReached(deps, ai)) {
    deps.logger.warn({ limitUsd: ai.dailySpendLimitUsd }, "daily AI spend limit reached");
    throw new ServiceUnavailableError(
      "AI_PAUSED",
      "AI features are paused for today. Please try again tomorrow.",
    );
  }
  return { ai, llm: ai.model };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Reviews run during an interview are visible only to that interview's interviewers and
 * observers; everyone else with access to the board (the candidate first of all) never sees
 * them, not even in the list.
 */
function visibleTo(userId: string) {
  // A null graph is a private board's review running without being stored: never listed.
  return sql`${reviews.graph} is not null and (${reviews.interviewId} is null or exists (
    select 1 from ${interviewParticipants} p
    where p.interview_id = ${reviews.interviewId} and p.user_id = ${userId}
      and p.role in ('interviewer', 'observer')))`;
}

async function loadReviewRecord(
  deps: ApiDeps,
  boardId: string,
  reviewId: string,
  userId: string,
): Promise<ReviewRecord> {
  const [row] = await deps.db
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
    .where(and(eq(reviews.id, reviewId), eq(reviews.boardId, boardId), visibleTo(userId)));
  if (!row) throw new NotFoundError("Review not found");
  // Stored by this server after validation; re-validated on the way out anyway.
  return reviewRecordSchema.parse({
    id: row.id,
    boardId: row.boardId,
    status: row.status,
    requestedBy:
      row.requestedBy === null
        ? null
        : { id: row.requestedBy, name: row.requesterName ?? row.requesterEmail ?? "Unknown user" },
    problemStatement: row.problemStatement,
    requirements: row.requirements,
    model: row.model,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    errorCode: row.errorCode,
    review: row.result === null ? null : aiReviewSchema.parse(row.result),
    graph: designGraphSchema.parse(row.graph),
    ruleFindings: z.array(findingSchema).parse(row.ruleFindings),
  });
}

/**
 * The finished review of a private board the user didn't want stored: built in memory and
 * streamed to the requester only; the server keeps nothing but the usage row.
 */
async function unstoredReviewRecord(
  deps: ApiDeps,
  input: {
    reviewId: string;
    boardId: string;
    userId: string;
    body: { problemStatement: string; requirements: string };
    design: DesignCheckResult;
    result: unknown;
    model: string;
  },
): Promise<ReviewRecord> {
  const [profile] = await deps.db
    .select({ name: profiles.displayName, email: profiles.email })
    .from(profiles)
    .where(eq(profiles.id, input.userId));
  const now = new Date().toISOString();
  return reviewRecordSchema.parse({
    id: input.reviewId,
    boardId: input.boardId,
    status: "completed",
    requestedBy: { id: input.userId, name: profile?.name ?? profile?.email ?? "You" },
    problemStatement: input.body.problemStatement,
    requirements: input.body.requirements,
    model: input.model,
    createdAt: now,
    completedAt: now,
    errorCode: null,
    review: input.result,
    graph: input.design.graph,
    ruleFindings: input.design.findings,
  });
}

/** Starts a server-sent event stream on the raw response (CORS headers kept). */
function openEventStream(reply: FastifyReply) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    ...(reply.getHeaders() as Record<string, string>),
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    // Proxies (nginx, Render) must not buffer the stream.
    "x-accel-buffering": "no",
  });
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, HEARTBEAT_MS);
  return {
    send(event: ReviewStreamEvent) {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    end() {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    },
    onClientGone(listener: () => void) {
      res.on("close", () => {
        clearInterval(heartbeat);
        if (!res.writableFinished) listener();
      });
    },
  };
}

export function registerReviewRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get("/me/ai-quota", async (request): Promise<AiQuota> => {
    const user = requireUser(request);
    const entitlement = await getEntitlement(deps.db, user.id, nowOf(deps));
    const used = await reviewsUsed(deps.db, user.id, entitlement);
    const ai = deps.ai;
    const available =
      ai?.model !== undefined && ai.enabled && !(await isSpendLimitReached(deps, ai));
    return {
      plan: entitlement.plan,
      reviewsUsed: used,
      reviewsLimit: entitlement.reviewsPerMonth,
      resetsAt: quotaResetsAt().toISOString(),
      liveHints: entitlement.limits.liveHints,
      available,
    };
  });

  app.get("/boards/:id/reviews", async (request): Promise<{ reviews: ReviewSummary[] }> => {
    const user = requireUser(request);
    const { id } = parse(idParams, request.params);
    await authorize(deps, id, user.id, "read", { shareToken: shareTokenOf(request) });
    const rows = await deps.db
      .select({
        id: reviews.id,
        status: reviews.status,
        createdAt: reviews.createdAt,
        problemStatement: reviews.problemStatement,
        result: reviews.result,
        name: profiles.displayName,
        email: profiles.email,
      })
      .from(reviews)
      .leftJoin(profiles, eq(profiles.id, reviews.requestedBy))
      .where(and(eq(reviews.boardId, id), visibleTo(user.id)))
      .orderBy(desc(reviews.createdAt))
      .limit(50);
    return {
      reviews: rows.map((row) => {
        const result = row.result === null ? null : aiReviewSchema.safeParse(row.result);
        const review = result?.success ? result.data : null;
        return {
          id: row.id,
          status: row.status,
          createdAt: row.createdAt.toISOString(),
          requestedByName: row.name ?? row.email ?? null,
          problemStatement: row.problemStatement,
          findingCount: review?.findings.length ?? 0,
          overallScore: review ? overallScore(review.scores) : null,
        };
      }),
    };
  });

  app.get("/boards/:id/reviews/:reviewId", async (request): Promise<ReviewRecord> => {
    const user = requireUser(request);
    const { id, reviewId } = parse(reviewParams, request.params);
    await authorize(deps, id, user.id, "read", { shareToken: shareTokenOf(request) });
    return loadReviewRecord(deps, id, reviewId, user.id);
  });

  /**
   * Runs an AI review of the board as it is stored now, streaming progress as server-sent
   * events. Everything that can refuse the request (auth, AI switch, spend limit, empty or
   * oversized board, monthly quota → 402) happens before the stream starts and before
   * Claude is called.
   */
  app.post(
    "/boards/:id/reviews",
    // A private board's graph comes with the request (up to AI_REVIEW_MAX_ELEMENTS elements).
    { bodyLimit: GRAPH_BODY_LIMIT, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const user = requireUser(request);
      const { id } = parse(idParams, request.params);
      const body = parse(reviewRequestSchema, request.body ?? {});
      const access = await authorize(deps, id, user.id, "read", {
        shareToken: shareTokenOf(request),
      });
      const privateInput = body.private;
      // Normal boards are always read from the database, never from the request; private
      // boards can't be read by the server, so their graph must come with explicit consent.
      if (access.isPrivate && !privateInput)
        throw new BadRequestError(
          "This board is end-to-end encrypted: confirm sending its graph for this review.",
        );
      if (!access.isPrivate && privateInput)
        throw new BadRequestError("Only private boards send their graph with the request.");
      const store = privateInput?.store ?? true;
      // During an interview the AI reviews for the hiring side only; the review is tagged
      // with the interview so the candidate never sees it.
      const interview = await activeInterviewContext(deps, id, user.id);
      if (interview && interview.role !== "interviewer" && interview.role !== "observer")
        throw new ForbiddenError("AI reviews are turned off for candidates during an interview.");
      const { ai, llm } = await requireAi(deps);
      if (!deps.boardStore)
        throw new ServiceUnavailableError(
          "AI_UNAVAILABLE",
          "AI reviews aren't available right now.",
        );

      // The rules always run here, on whichever graph is reviewed.
      const design: DesignCheckResult = privateInput
        ? { graph: privateInput.graph, ...runRules(privateInput.graph) }
        : await loadDesign(deps.boardStore, id);
      if (design.graph.nodes.length === 0)
        throw new UnprocessableError(
          "EMPTY_DESIGN",
          "Add some system-design components (services, databases, queues…) from the shape palette first.",
        );
      if (graphSize(design) > ai.maxElements)
        throw new PayloadTooLargeError(
          `This board has too many components and connections for an AI review (limit ${String(ai.maxElements)}).`,
        );

      // Not stored: the row is only a quota reservation, with no content, deleted at the end.
      const reviewId = await reserveReview(
        deps.db,
        {
          boardId: id,
          userId: user.id,
          problemStatement: store ? body.problemStatement : "",
          requirements: store ? body.requirements : "",
          graph: store ? design.graph : null,
          graphFormatVersion: GRAPH_FORMAT_VERSION,
          ruleFindings: store ? design.findings : [],
          model: ai.review.model,
          interviewId: interview?.interviewId ?? null,
        },
        nowOf(deps),
      );
      const log = request.log.child({ reviewId, boardId: id });

      const stream = openEventStream(reply);
      const abort = new AbortController();
      stream.onClientGone(() => {
        abort.abort();
      });
      stream.send({ type: "stage", stage: "preparing" });
      stream.send({ type: "stage", stage: "reviewing" });

      let lastProgress = 0;
      let outcome: CallOutcome | null = null;
      let usageRecorded = false;
      try {
        const run = await runReview(llm, ai.review, {
          graph: design.graph,
          ruleFindings: design.findings,
          problemStatement: body.problemStatement,
          requirements: body.requirements,
          signal: abort.signal,
          onOutputProgress: (tokens) => {
            const now = Date.now();
            if (now - lastProgress < PROGRESS_INTERVAL_MS) return;
            lastProgress = now;
            stream.send({ type: "progress", outputTokens: tokens });
          },
        });
        outcome = run;
        stream.send({ type: "stage", stage: "validating" });
        const call = run;
        const result = run.status === "ok" ? run.review : null;
        const completed = result !== null;
        const cost = await deps.db.transaction(async (tx) => {
          // Usage and status change together, so the quota count never has a gap.
          const usd = await recordUsage(
            tx,
            { kind: "review", userId: user.id, boardId: id, reviewId },
            call,
          );
          if (store)
            await tx
              .update(reviews)
              .set({
                status: completed ? "completed" : "failed",
                result,
                errorCode: completed ? null : call.status,
                completedAt: new Date(),
              })
              .where(eq(reviews.id, reviewId));
          // Usage (tokens, cost) keeps counting toward the quota; the content goes.
          else await tx.delete(reviews).where(eq(reviews.id, reviewId));
          return usd;
        });
        usageRecorded = true;
        const logFields = {
          status: call.status,
          costUsdMicros: cost,
          usage: call.usage,
          latencyMs: call.latencyMs,
          requestId: call.requestId,
          repair: call.stats,
        };
        if (completed) {
          log.info(logFields, "AI review completed");
          stream.send({
            type: "done",
            review: store
              ? await loadReviewRecord(deps, id, reviewId, user.id)
              : await unstoredReviewRecord(deps, {
                  reviewId,
                  boardId: id,
                  userId: user.id,
                  body,
                  design,
                  result,
                  model: ai.review.model,
                }),
          });
        } else {
          log.warn({ ...logFields, err: call.error }, "AI review failed");
          const failure = FAILURE_MESSAGES[call.status] ?? FAILURE_MESSAGES.error;
          if (failure) stream.send({ type: "error", ...failure });
        }
      } catch (error) {
        log.error({ err: error }, "AI review crashed");
        // Whatever the call cost must still be counted toward the daily spend.
        if (outcome && !usageRecorded)
          await recordUsage(
            deps.db,
            { kind: "review", userId: user.id, boardId: id, reviewId },
            outcome,
          ).catch((usageError: unknown) => {
            log.error({ err: usageError }, "could not record AI usage");
          });
        // Don't leave the reservation holding quota (or, unstored, any row at all).
        await (
          store
            ? deps.db
                .update(reviews)
                .set({ status: "failed", errorCode: "server_error", completedAt: new Date() })
                .where(and(eq(reviews.id, reviewId), eq(reviews.status, "running")))
            : deps.db.delete(reviews).where(eq(reviews.id, reviewId))
        ).catch((updateError: unknown) => {
          log.error({ err: updateError }, "could not mark review failed");
        });
        const failure = FAILURE_MESSAGES.error;
        if (failure) stream.send({ type: "error", ...failure });
      } finally {
        stream.end();
      }
    },
  );

  /**
   * Live hints while drawing (Pro and Team, editors). Cheap model, capped per hour, and
   * skipped without a call when the graph hasn't meaningfully changed since the last hint.
   */
  app.post(
    "/boards/:id/hints",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request): Promise<HintsResponse> => {
      const user = requireUser(request);
      const { id } = parse(idParams, request.params);
      const access = await authorize(deps, id, user.id, "write", {
        shareToken: shareTokenOf(request),
      });
      refuseIfPrivate(
        access,
        "Live hints are off for private boards: they would send the board to the server on every change.",
      );
      // No AI help while an interview is running on this board.
      if (await activeInterviewContext(deps, id, user.id)) return { hints: [], skipped: true };
      throwIfBlocked(
        checkFeature(await getEntitlement(deps.db, user.id, nowOf(deps)), "liveHints"),
      );
      const { ai, llm } = await requireAi(deps);
      if (!deps.boardStore)
        throw new ServiceUnavailableError("AI_UNAVAILABLE", "AI hints aren't available right now.");

      const design = await loadDesign(deps.boardStore, id);
      if (design.graph.nodes.length < HINT_MIN_COMPONENTS || graphSize(design) > ai.maxElements)
        return { hints: [], skipped: true };

      const fingerprint = sha256(graphFingerprint(design.graph));
      const recent = and(
        eq(aiUsage.userId, user.id),
        eq(aiUsage.kind, "hint"),
        gt(aiUsage.createdAt, sql`now() - interval '1 hour'`),
      );
      const [last] = await deps.db
        .select({ fingerprint: aiUsage.fingerprint })
        .from(aiUsage)
        .where(and(recent, eq(aiUsage.boardId, id)))
        .orderBy(desc(aiUsage.createdAt))
        .limit(1);
      if (last?.fingerprint === fingerprint) return { hints: [], skipped: true };
      const [calls] = await deps.db.select({ n: count() }).from(aiUsage).where(recent);
      if ((calls?.n ?? 0) >= ai.hints.perHour)
        throw new TooManyRequestsError(
          "HINT_LIMIT",
          "You've had a lot of hints this hour — they'll resume shortly.",
        );

      const outcome = await runHints(llm, ai.hints, {
        graph: design.graph,
        ruleFindings: design.findings,
      });
      const cost = await recordUsage(
        deps.db,
        { kind: "hint", userId: user.id, boardId: id, fingerprint },
        outcome,
      );
      const logFields = {
        boardId: id,
        status: outcome.status,
        costUsdMicros: cost,
        usage: outcome.usage,
        latencyMs: outcome.latencyMs,
        requestId: outcome.requestId,
      };
      if (outcome.status !== "ok" || outcome.hints === null) {
        // Hints are best effort: the editor just shows none.
        request.log.warn({ ...logFields, err: outcome.error }, "AI hints failed");
        return { hints: [], skipped: false };
      }
      request.log.info(logFields, "AI hints");
      return { hints: outcome.hints, skipped: false };
    },
  );
}
