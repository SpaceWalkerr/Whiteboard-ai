import {
  effectiveEntitlement,
  type Entitlement,
  type EntitlementGrant,
  type EntitlementSource,
  type Plan,
} from "@whiteboard/shared/entitlements";
import { and, entitlements, eq, sql, type Database } from "@whiteboard/shared/db";
import type { Tx } from "../api/deps";

type Executor = Database | Tx;

/**
 * The user's plan right now, from their grants (subscriptions, team seat, student trial,
 * manual). The decision itself is packages/shared/entitlements; this only loads the facts.
 */
export async function loadEntitlement(
  db: Executor,
  userId: string,
  now: Date,
): Promise<Entitlement> {
  return effectiveEntitlement(await loadGrants(db, userId), now);
}

export async function loadGrants(db: Executor, userId: string): Promise<EntitlementGrant[]> {
  const rows = await db
    .select({
      plan: entitlements.plan,
      source: entitlements.source,
      sourceId: entitlements.sourceId,
      validUntil: entitlements.validUntil,
      orgId: entitlements.orgId,
      seats: entitlements.seats,
      aiReviewsPerMonthOverride: entitlements.aiReviewsPerMonthOverride,
    })
    .from(entitlements)
    .where(eq(entitlements.userId, userId));
  return rows;
}

export interface GrantInput {
  userId: string;
  plan: Plan;
  source: EntitlementSource;
  sourceId: string;
  /** null = open-ended; a past date ends the grant (kept for the expiry sweep and history). */
  validUntil: Date | null;
  orgId?: string | null;
  seats?: number | null;
}

/**
 * Creates or updates one grant. Changing `valid_until` re-arms the expiry sweep for it (a
 * renewed subscription that lapses again gets processed again).
 */
export async function upsertGrant(tx: Tx, grant: GrantInput): Promise<void> {
  await tx
    .insert(entitlements)
    .values({
      userId: grant.userId,
      plan: grant.plan,
      source: grant.source,
      sourceId: grant.sourceId,
      validUntil: grant.validUntil,
      orgId: grant.orgId ?? null,
      seats: grant.seats ?? null,
    })
    .onConflictDoUpdate({
      target: [entitlements.userId, entitlements.source, entitlements.sourceId],
      set: {
        plan: sql`excluded.plan`,
        validUntil: sql`excluded.valid_until`,
        orgId: sql`excluded.org_id`,
        seats: sql`excluded.seats`,
        updatedAt: sql`now()`,
        expiryProcessedAt: sql`case when ${entitlements.validUntil} is not distinct from excluded.valid_until then ${entitlements.expiryProcessedAt} else null end`,
      },
    });
}

/**
 * Ends a grant at `now` (if it exists and runs longer). The row stays: the expiry sweep then
 * enforces the lower limits and sends the "downgraded" email exactly once.
 */
export async function endGrant(
  tx: Tx,
  where: { userId: string; source: EntitlementSource; sourceId: string },
  now: Date,
): Promise<boolean> {
  const updated = await tx
    .update(entitlements)
    .set({ validUntil: now, updatedAt: sql`now()`, expiryProcessedAt: null })
    .where(
      and(
        eq(entitlements.userId, where.userId),
        eq(entitlements.source, where.source),
        eq(entitlements.sourceId, where.sourceId),
        sql`(${entitlements.validUntil} is null or ${entitlements.validUntil} > ${now.toISOString()}::timestamptz)`,
      ),
    )
    .returning({ id: entitlements.id });
  return updated.length > 0;
}
