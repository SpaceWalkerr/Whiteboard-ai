import { GRACE_PERIOD_DAYS, PLAN_LIMITS, PLAN_RANK, type Plan, type PlanLimits } from "./limits";

/** Where a grant comes from. */
export const ENTITLEMENT_SOURCES = [
  "subscription",
  "team_seat",
  "student_trial",
  "manual",
] as const;
export type EntitlementSource = (typeof ENTITLEMENT_SOURCES)[number];

/**
 * One reason a user has a plan (a row of the `entitlements` table). A user may hold several
 * (a student trial and a team seat); the best one that is still valid wins.
 */
export interface EntitlementGrant {
  plan: Plan;
  source: EntitlementSource;
  /** Subscription id, team org id, trial id or "manual". */
  sourceId: string;
  /** The grant stops counting at this instant; null = until something changes it. */
  validUntil: Date | null;
  /** Team: the organization whose seat this is (its AI allowance is pooled). */
  orgId?: string | null;
  /** Team: seats of that organization (pool size). */
  seats?: number | null;
  /** Replaces the plan's monthly AI review allowance (support, manual grants). */
  aiReviewsPerMonthOverride?: number | null;
}

export interface Entitlement {
  plan: Plan;
  source: EntitlementSource | "free";
  validUntil: Date | null;
  limits: PlanLimits;
  /** Monthly AI reviews available to this user (the whole pool for a team seat). */
  reviewsPerMonth: number;
  /** Team seat: reviews are counted across every seat of this organization. */
  pool: { orgId: string; seats: number } | null;
}

export const FREE_ENTITLEMENT: Entitlement = {
  plan: "free",
  source: "free",
  validUntil: null,
  limits: PLAN_LIMITS.free,
  reviewsPerMonth: PLAN_LIMITS.free.aiReviewsPerMonth,
  pool: null,
};

export function isGrantActive(grant: Pick<EntitlementGrant, "validUntil">, now: Date): boolean {
  return grant.validUntil === null || grant.validUntil.getTime() > now.getTime();
}

/**
 * The user's plan right now: the highest plan among grants that haven't expired (ties: the
 * one lasting longest). Expiry is compared with `now` on every call, so a late background
 * job can never extend a paid plan.
 */
export function effectiveEntitlement(grants: readonly EntitlementGrant[], now: Date): Entitlement {
  let best: EntitlementGrant | null = null;
  for (const grant of grants) {
    if (!isGrantActive(grant, now)) continue;
    if (best === null || outranks(grant, best)) best = grant;
  }
  if (best === null) return FREE_ENTITLEMENT;
  const limits = PLAN_LIMITS[best.plan];
  const pool =
    best.source === "team_seat" && best.orgId && best.seats
      ? { orgId: best.orgId, seats: best.seats }
      : null;
  return {
    plan: best.plan,
    source: best.source,
    validUntil: best.validUntil,
    limits,
    reviewsPerMonth:
      best.aiReviewsPerMonthOverride ??
      (pool ? limits.aiReviewsPerMonth * pool.seats : limits.aiReviewsPerMonth),
    pool,
  };
}

function outranks(a: EntitlementGrant, b: EntitlementGrant): boolean {
  if (PLAN_RANK[a.plan] !== PLAN_RANK[b.plan]) return PLAN_RANK[a.plan] > PLAN_RANK[b.plan];
  if (a.validUntil === null) return b.validUntil !== null;
  if (b.validUntil === null) return false;
  return a.validUntil.getTime() > b.validUntil.getTime();
}

// ── Subscriptions → grants ──────────────────────────────────────────────────────────────────

/** Provider-neutral subscription states (see each provider's mapping). */
export const SUBSCRIPTION_STATUSES = [
  /** Checkout started, nothing paid or authorized. */
  "created",
  /** Payment method authorized; the first charge is being taken. */
  "authenticated",
  "active",
  /** A renewal charge failed; the provider is retrying (grace period). */
  "past_due",
  /** The provider stopped retrying (still in our grace period until it ends). */
  "halted",
  "paused",
  "cancelled",
  "completed",
  /** Checkout was never completed. */
  "expired",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Statuses in which an organization "has" a subscription (no second checkout). */
export const LIVE_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  "authenticated",
  "active",
  "past_due",
  "halted",
];

const FAILED: readonly SubscriptionStatus[] = ["past_due", "halted"];
const ENDED: readonly SubscriptionStatus[] = ["cancelled", "completed", "expired"];

export interface SubscriptionState {
  status: SubscriptionStatus;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** Set while a failed payment is being retried (see nextGrace). */
  graceUntil: Date | null;
}

/**
 * Until when a subscription grants its plan: null = open-ended (renews), a date = until then,
 * `false` = not at all. Paid time is never cut short: a cancellation keeps the plan to the end
 * of the paid period, a failed payment keeps it through the grace period.
 */
export function subscriptionValidUntil(sub: SubscriptionState): Date | null | false {
  if (sub.status === "created" || sub.status === "paused") return false;
  if (FAILED.includes(sub.status)) return sub.graceUntil ?? false;
  if (ENDED.includes(sub.status)) {
    // Ended after failed payments: whatever grace remains. Otherwise: the paid period.
    return sub.graceUntil ?? sub.currentPeriodEnd ?? false;
  }
  // authenticated / active
  return sub.cancelAtPeriodEnd ? (sub.currentPeriodEnd ?? false) : null;
}

/**
 * Grace bookkeeping when a subscription moves to `next`: the 7 days start at the FIRST failed
 * payment (later retries don't extend it) and end when a payment succeeds again.
 */
export function nextGrace(
  previous: { status: SubscriptionStatus | null; graceUntil: Date | null },
  next: SubscriptionStatus,
  now: Date,
): Date | null {
  if (FAILED.includes(next)) {
    if (previous.graceUntil !== null) return previous.graceUntil;
    return new Date(now.getTime() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  }
  if (next === "active" || next === "authenticated") return null;
  // Ending while in grace keeps the remaining grace; ending normally has none.
  return previous.graceUntil;
}
