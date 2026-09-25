import { aiUsage, sql, type AiCallKind, type Database } from "@whiteboard/shared/db";
import { costUsdMicros } from "./pricing";
import type { CallOutcome } from "./reviewer";

type Executor = Pick<Database, "insert">;

export interface UsageContext {
  kind: AiCallKind;
  userId: string;
  boardId: string;
  reviewId?: string | null;
  fingerprint?: string | null;
}

/**
 * Records one Claude call: tokens, cost and outcome. Every call gets a row, including
 * failed, refused and aborted ones (they can still cost money). Returns the cost.
 */
export async function recordUsage(
  tx: Executor,
  context: UsageContext,
  outcome: CallOutcome,
): Promise<number> {
  const cost = costUsdMicros(outcome.model, outcome.usage);
  await tx.insert(aiUsage).values({
    kind: context.kind,
    userId: context.userId,
    boardId: context.boardId,
    reviewId: context.reviewId ?? null,
    fingerprint: context.fingerprint ?? null,
    model: outcome.model,
    status: outcome.status,
    inputTokens: outcome.usage.inputTokens,
    outputTokens: outcome.usage.outputTokens,
    cacheCreationTokens: outcome.usage.cacheCreationTokens,
    cacheReadTokens: outcome.usage.cacheReadTokens,
    costUsdMicros: cost,
    latencyMs: outcome.latencyMs,
    requestId: outcome.requestId,
  });
  return cost;
}

/** Total AI spend since midnight UTC, across every user and instance, in micro-dollars. */
export async function spendTodayMicros(db: Database): Promise<number> {
  const rows = await db.execute<{ total: string | number }>(sql`
    select coalesce(sum(${aiUsage.costUsdMicros}), 0) as total
    from ${aiUsage}
    where ${aiUsage.createdAt} >= date_trunc('day', now(), 'UTC')`);
  return Number(rows[0]?.total ?? 0);
}
