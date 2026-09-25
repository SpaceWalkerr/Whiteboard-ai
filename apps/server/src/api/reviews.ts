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
  profiles,
  reviews,
  sql,
  type AiCallStatus,
} from "@whiteboard/shared/db";
import { graphSize, loadDesign } from "../ai/boardGraph";
import {
  getEntitlement,
  quotaResetsAt,
  reserveReview,
  reviewsUsedThisMonth,
} from "../ai/entitlements";
import type { LanguageModel } from "../ai/model";
import { runHints, runReview, type CallOutcome } from "../ai/reviewer";
import { recordUsage, spendTodayMicros } from "../ai/usage";
import { requireUser } from "../auth/requestAuth";
import {
  NotFoundError,
  PayloadTooLargeError,
  PaymentRequiredError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnprocessableError,
} from "../errors";
import { authorize, shareTokenOf } from "./boards";
import type { AiConfig, ApiDeps } from "./deps";
import { parse } from "./validation";

const idParams = z.object({ id: z.uuid() });
const reviewParams = z.object({ id: z.uuid(), reviewId: z.uuid() });

/** Live hints need at least this many components to say anything useful. */
const HINT_MIN_COMPONENTS = 3;
const PROGRESS_INTERVAL_MS = 500;
const HEARTBEAT_MS = 15_000;

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

async function loadReviewRecord(
  deps: ApiDeps,
  boardId: string,
  reviewId: string,
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
    .where(and(eq(reviews.id, reviewId), eq(reviews.boardId, boardId)));
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
    const [entitlement, used] = await Promise.all([
      getEntitlement(deps.db, user.id),
      reviewsUsedThisMonth(deps.db, user.id),
    ]);
    const ai = deps.ai;
    const available =
      ai?.model !== undefined && ai.enabled && !(await isSpendLimitReached(deps, ai));
    return {
      plan: entitlement.plan,
      reviewsUsed: used,
      reviewsLimit: entitlement.reviewsPerMonth,
      resetsAt: quotaResetsAt().toISOString(),
      liveHints: entitlement.liveHints,
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
      .where(eq(reviews.boardId, id))
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
    return loadReviewRecord(deps, id, reviewId);
  });

  /**
   * Runs an AI review of the board as it is stored now, streaming progress as server-sent
   * events. Everything that can refuse the request (auth, AI switch, spend limit, empty or
   * oversized board, monthly quota → 402) happens before the stream starts and before
   * Claude is called.
   */
  app.post(
    "/boards/:id/reviews",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const user = requireUser(request);
      const { id } = parse(idParams, request.params);
      const body = parse(reviewRequestSchema, request.body ?? {});
      await authorize(deps, id, user.id, "read", { shareToken: shareTokenOf(request) });
      const { ai, llm } = await requireAi(deps);
      if (!deps.boardStore)
        throw new ServiceUnavailableError(
          "AI_UNAVAILABLE",
          "AI reviews aren't available right now.",
        );

      const design = await loadDesign(deps.boardStore, id);
      if (design.graph.nodes.length === 0)
        throw new UnprocessableError(
          "EMPTY_DESIGN",
          "Add some system-design components (services, databases, queues…) from the shape palette first.",
        );
      if (graphSize(design) > ai.maxElements)
        throw new PayloadTooLargeError(
          `This board has too many components and connections for an AI review (limit ${String(ai.maxElements)}).`,
        );

      const reviewId = await reserveReview(deps.db, {
        boardId: id,
        userId: user.id,
        problemStatement: body.problemStatement,
        requirements: body.requirements,
        graph: design.graph,
        graphFormatVersion: GRAPH_FORMAT_VERSION,
        ruleFindings: design.findings,
        model: ai.review.model,
      });
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
          await tx
            .update(reviews)
            .set({
              status: completed ? "completed" : "failed",
              result,
              errorCode: completed ? null : call.status,
              completedAt: new Date(),
            })
            .where(eq(reviews.id, reviewId));
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
          stream.send({ type: "done", review: await loadReviewRecord(deps, id, reviewId) });
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
        // Don't leave the reservation holding quota.
        await deps.db
          .update(reviews)
          .set({ status: "failed", errorCode: "server_error", completedAt: new Date() })
          .where(and(eq(reviews.id, reviewId), eq(reviews.status, "running")))
          .catch((updateError: unknown) => {
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
      await authorize(deps, id, user.id, "write", { shareToken: shareTokenOf(request) });
      const entitlement = await getEntitlement(deps.db, user.id);
      if (!entitlement.liveHints)
        throw new PaymentRequiredError(
          "PLAN_REQUIRED",
          "Live AI hints are included in the Pro and Team plans.",
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
