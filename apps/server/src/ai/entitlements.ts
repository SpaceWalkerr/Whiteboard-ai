import { checkAiReview, type Entitlement } from "@whiteboard/shared/entitlements";
import { aiUsage, entitlements, reviews, sql, type Database } from "@whiteboard/shared/db";
import type { Tx } from "../api/deps";
import { loadEntitlement } from "../billing/entitlements";
import { throwIfBlocked } from "../billing/limits";

export type { Entitlement };

/** The user's plan and limits right now (see billing/entitlements.ts). */
export async function getEntitlement(
  db: Database | Tx,
  userId: string,
  now: Date = new Date(),
): Promise<Entitlement> {
  return loadEntitlement(db, userId, now);
}

/** A reservation older than this is treated as crashed and stops holding quota. */
const RUNNING_RESERVATION_MINUTES = 10;

/**
 * Reviews that count against this calendar month's (UTC) allowance: completed reviews and
 * reviews the user aborted after Claude started (both recorded in ai_usage, which outlives
 * deleted boards), plus reviews running right now (reservations). Failures on our side —
 * model errors, refusals, truncated or invalid output — are free. A Team seat counts the
 * whole team's reviews (the allowance is pooled across its seats).
 */
export async function reviewsUsed(
  db: Database | Tx,
  userId: string,
  entitlement: Entitlement,
): Promise<number> {
  const users = entitlement.pool
    ? sql`(select ${entitlements.userId} from ${entitlements}
          where ${entitlements.source} = 'team_seat' and ${entitlements.orgId} = ${entitlement.pool.orgId}
            and (${entitlements.validUntil} is null or ${entitlements.validUntil} > now()))`
    : sql`(select ${userId}::uuid)`;
  const rows = await db.execute<{ used: string | number }>(sql`
    select
      (select count(*) from ${aiUsage}
        where ${aiUsage.userId} in ${users}
          and ${aiUsage.kind} = 'review'
          and ${aiUsage.status} in ('ok', 'aborted')
          and ${aiUsage.createdAt} >= date_trunc('month', now(), 'UTC'))
      +
      (select count(*) from ${reviews}
        where ${reviews.requestedBy} in ${users}
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
  /** Null: a private board's review the user didn't opt in to storing (no content kept). */
  graph: unknown;
  graphFormatVersion: number;
  ruleFindings: unknown;
  model: string;
  /** Set when run during an interview (visible to its interviewers and observers only). */
  interviewId?: string | null;
}

/**
 * Checks the allowance and inserts a `running` review in one transaction, serialized per
 * user with an advisory lock, so two parallel requests can't both take the last review.
 * Throws PaymentRequiredError (402) when the allowance is used up; nothing is reserved.
 */
export async function reserveReview(
  db: Database,
  review: NewReview,
  now: Date = new Date(),
): Promise<string> {
  return db.transaction(async (tx) => {
    const entitlement = await getEntitlement(tx, review.userId, now);
    // Per user, or per team when the allowance is pooled: two teammates can't both take
    // the team's last review.
    const key = entitlement.pool
      ? `ai-review-quota:org:${entitlement.pool.orgId}`
      : `ai-review-quota:${review.userId}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    throwIfBlocked(checkAiReview(entitlement, await reviewsUsed(tx, review.userId, entitlement)));
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
        interviewId: review.interviewId ?? null,
      })
      .returning({ id: reviews.id });
    if (!row) throw new Error("review insert failed");
    return row.id;
  });
}
