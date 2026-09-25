import { PLAN_LIMITS, PLAN_NAMES, type Plan } from "@whiteboard/shared/plans";
import { aiUsage, entitlements, eq, reviews, sql, type Database } from "@whiteboard/shared/db";
import type { Tx } from "../api/deps";
import { PaymentRequiredError } from "../errors";

export interface Entitlement {
  plan: Plan;
  reviewsPerMonth: number;
  liveHints: boolean;
}

/** A reservation older than this is treated as crashed and stops holding quota. */
const RUNNING_RESERVATION_MINUTES = 10;

/** The user's plan and limits; users without a row are on Free. */
export async function getEntitlement(db: Database | Tx, userId: string): Promise<Entitlement> {
  const [row] = await db
    .select({ plan: entitlements.plan, override: entitlements.aiReviewsPerMonthOverride })
    .from(entitlements)
    .where(eq(entitlements.userId, userId));
  const plan = row?.plan ?? "free";
  const limits = PLAN_LIMITS[plan];
  return {
    plan,
    reviewsPerMonth: row?.override ?? limits.aiReviewsPerMonth,
    liveHints: limits.liveHints,
  };
}

/**
 * Reviews that count against this calendar month's (UTC) allowance: completed reviews and
 * reviews the user aborted after Claude started (both recorded in ai_usage, which outlives
 * deleted boards), plus reviews running right now (reservations). Failures on our side —
 * model errors, refusals, truncated or invalid output — are free.
 */
export async function reviewsUsedThisMonth(db: Database | Tx, userId: string): Promise<number> {
  const rows = await db.execute<{ used: string | number }>(sql`
    select
      (select count(*) from ${aiUsage}
        where ${aiUsage.userId} = ${userId}
          and ${aiUsage.kind} = 'review'
          and ${aiUsage.status} in ('ok', 'aborted')
          and ${aiUsage.createdAt} >= date_trunc('month', now(), 'UTC'))
      +
      (select count(*) from ${reviews}
        where ${reviews.requestedBy} = ${userId}
          and ${reviews.status} = 'running'
          and ${reviews.createdAt} > now() - make_interval(mins => ${RUNNING_RESERVATION_MINUTES}))
      as used`);
  return Number(rows[0]?.used ?? 0);
}

/** Start of next month, UTC: when the allowance resets. */
export function quotaResetsAt(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export interface NewReview {
  boardId: string;
  userId: string;
  problemStatement: string;
  requirements: string;
  graph: unknown;
  graphFormatVersion: number;
  ruleFindings: unknown;
  model: string;
}

/**
 * Checks the allowance and inserts a `running` review in one transaction, serialized per
 * user with an advisory lock, so two parallel requests can't both take the last review.
 * Throws PaymentRequiredError (402) when the allowance is used up; nothing is reserved.
 */
export async function reserveReview(db: Database, review: NewReview): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`ai-review-quota:${review.userId}`}, 0))`,
    );
    const entitlement = await getEntitlement(tx, review.userId);
    const used = await reviewsUsedThisMonth(tx, review.userId);
    if (used >= entitlement.reviewsPerMonth) {
      throw new PaymentRequiredError(
        "QUOTA_EXCEEDED",
        `You've used all ${String(entitlement.reviewsPerMonth)} AI reviews included in the ${PLAN_NAMES[entitlement.plan]} plan this month.`,
      );
    }
    const [row] = await tx
      .insert(reviews)
      .values({
        boardId: review.boardId,
        requestedBy: review.userId,
        status: "running",
        problemStatement: review.problemStatement,
        requirements: review.requirements,
        graph: review.graph,
        graphFormatVersion: review.graphFormatVersion,
        ruleFindings: review.ruleFindings,
        model: review.model,
      })
      .returning({ id: reviews.id });
    if (!row) throw new Error("review insert failed");
    return row.id;
  });
}
