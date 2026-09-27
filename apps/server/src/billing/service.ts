import { createHash } from "node:crypto";
import {
  LIVE_SUBSCRIPTION_STATUSES,
  PLAN_RANK,
  STUDENT_TRIAL_MONTHS,
  effectiveEntitlement,
  isStudentEmail,
  type Plan,
  type SubscriptionStatus,
} from "@whiteboard/shared/entitlements";
import type {
  BillingSummary,
  ChangePlanRequest,
  CheckoutRequest,
  CheckoutResponse,
  CouponPreview,
  PlanId,
} from "@whiteboard/shared/billing";
import {
  and,
  boards,
  coupons,
  desc,
  entitlements,
  eq,
  inArray,
  invoices,
  memberships,
  organizations,
  plans,
  sql,
  studentTrials,
  subscriptions,
  type SubscriptionRow,
} from "@whiteboard/shared/db";
import type { Tx } from "../api/deps";
import { displayNameFor, ensureWorkspace } from "../api/workspace";
import { audit } from "../audit/audit";
import type { AuthUser } from "../auth/verifier";
import { downgradedEmail, graceReminderEmail } from "../email/BillingEmails";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
} from "../errors";
import { reviewsUsed } from "../ai/entitlements";
import { noEffects, runEffects, type BillingConfig, type BillingContext } from "./context";
import { loadEntitlement, loadGrants, upsertGrant } from "./entitlements";
import { enforceOwnerLimits, lockKey } from "./limits";
import { ProviderError } from "./provider";
import { emailOf, refreshSubscriptionGrants, syncSubscription } from "./sync";

/** Cycles before a subscription completes on its own (10 years). */
const TOTAL_COUNT = { month: 120, year: 10 } as const;
/** A checkout that wasn't paid within this time isn't reused (a fresh one is created). */
const CHECKOUT_REUSE_MINUTES = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export function requireBilling(ctx: BillingContext): BillingConfig {
  if (!ctx.billing)
    throw new ServiceUnavailableError(
      "BILLING_UNAVAILABLE",
      "Payments aren't available right now. Please try again later.",
    );
  return ctx.billing;
}

/** Provider refusals become a 409 with the provider's reason; outages a 502-style 503. */
function providerFailure(error: unknown, action: string): Error {
  if (error instanceof ProviderError && error.refused)
    return new ConflictError(
      `The payment provider refused to ${action}${error.providerMessage ? `: ${error.providerMessage}` : "."}`,
    );
  return new ServiceUnavailableError(
    "PROVIDER_UNAVAILABLE",
    "The payment provider didn't respond. Please try again in a minute.",
  );
}

async function catalogPlan(tx: Tx, planId: PlanId) {
  const [plan] = await tx.select().from(plans).where(eq(plans.id, planId));
  if (!plan?.active) throw new BadRequestError("That plan isn't available.");
  return plan;
}

// ── Checkout ───────────────────────────────────────────────────────────────────────────────

export async function createCheckout(
  ctx: BillingContext,
  user: AuthUser,
  body: CheckoutRequest,
  ip: string,
): Promise<CheckoutResponse> {
  const config = requireBilling(ctx);
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    // One checkout at a time per user: a double click reuses the first one.
    await lockKey(tx, `billing-checkout:${user.id}`);
    const plan = await catalogPlan(tx, body.planId);
    const team = plan.tier === "team";
    if (team && body.seats === undefined)
      throw new BadRequestError("Choose how many seats the team needs.");
    if (!team && body.seats !== undefined && body.seats !== 1)
      throw new BadRequestError("Pro is for one person; choose Team for more seats.");
    const quantity = team ? (body.seats ?? 1) : 1;

    const orgId = team
      ? await teamOrgForCheckout(tx, user, body.teamName)
      : await ensureWorkspace(tx, user);
    const [live] = await tx
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.orgId, orgId),
          inArray(subscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]),
        ),
      );
    if (live)
      throw new ConflictError(
        "This workspace already has a subscription. Change its plan in billing settings instead.",
      );

    const coupon = body.couponCode
      ? await validCoupon(tx, body.couponCode, body.planId, now)
      : null;

    const [reusable] = await tx
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.orgId, orgId),
          eq(subscriptions.userId, user.id),
          eq(subscriptions.status, "created"),
          eq(subscriptions.planId, body.planId),
          eq(subscriptions.quantity, quantity),
          coupon
            ? eq(subscriptions.couponCode, coupon.code)
            : sql`${subscriptions.couponCode} is null`,
          sql`${subscriptions.createdAt} > ${new Date(now.getTime() - CHECKOUT_REUSE_MINUTES * 60_000).toISOString()}::timestamptz`,
        ),
      )
      .orderBy(desc(subscriptions.createdAt))
      .limit(1);

    let row: SubscriptionRow;
    if (reusable) {
      row = reusable;
    } else {
      let checkout;
      try {
        checkout = await config.provider.createCheckout({
          providerPlanId: config.providerPlanIds[body.planId],
          quantity,
          totalCount: TOTAL_COUNT[plan.interval],
          offerId: coupon?.providerOfferId ?? null,
          notes: { orgId, userId: user.id, planId: body.planId },
        });
      } catch (error) {
        throw providerFailure(error, "start the checkout");
      }
      const [inserted] = await tx
        .insert(subscriptions)
        .values({
          orgId,
          userId: user.id,
          provider: config.provider.name,
          providerSubscriptionId: checkout.subscription.id,
          providerCustomerId: checkout.subscription.customerId,
          planId: body.planId,
          status: checkout.subscription.status,
          quantity,
          couponCode: coupon?.code ?? null,
          syncedAt: now,
        })
        .returning();
      if (!inserted) throw new Error("subscription insert failed");
      row = inserted;
      await audit(tx, {
        action: "billing.checkout",
        actorId: user.id,
        orgId,
        targetType: "subscription",
        targetId: row.id,
        metadata: { planId: body.planId, quantity, coupon: coupon?.code ?? null },
        ip,
      });
    }
    return {
      provider: config.provider.name,
      subscriptionId: row.id,
      razorpay: { keyId: config.provider.publicKey, subscriptionId: row.providerSubscriptionId },
      prefill: { email: user.email, name: user.name ?? null },
      description: `Whiteboard.ai ${plan.tier === "team" ? `Team · ${String(quantity)} seats` : "Pro"} (${plan.interval === "year" ? "yearly" : "monthly"})`,
    };
  });
}

/** The user's team workspace without a paid subscription, else a new one. */
async function teamOrgForCheckout(
  tx: Tx,
  user: AuthUser,
  name: string | undefined,
): Promise<string> {
  const candidates = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .innerJoin(memberships, eq(memberships.orgId, organizations.id))
    .where(
      and(
        eq(organizations.kind, "team"),
        eq(memberships.userId, user.id),
        eq(memberships.role, "owner"),
        sql`not exists (select 1 from ${subscriptions} s where s.org_id = ${organizations.id}
          and s.status in ('authenticated', 'active', 'past_due', 'halted'))`,
      ),
    )
    .orderBy(desc(organizations.createdAt))
    .limit(1);
  const existing = candidates[0];
  if (existing) {
    if (name) await tx.update(organizations).set({ name }).where(eq(organizations.id, existing.id));
    return existing.id;
  }
  await ensureWorkspace(tx, user); // profile row (member lists show names)
  const [org] = await tx
    .insert(organizations)
    .values({ name: name ?? `${displayNameFor(user)}'s team`, kind: "team", createdBy: user.id })
    .returning({ id: organizations.id });
  if (!org) throw new Error("team insert failed");
  await tx.insert(memberships).values({ orgId: org.id, userId: user.id, role: "owner" });
  return org.id;
}

async function validCoupon(tx: Tx, code: string, planId: PlanId, now: Date) {
  const [coupon] = await tx.select().from(coupons).where(eq(coupons.code, code));
  const invalid = new BadRequestError("That coupon code isn't valid.");
  if (!coupon?.active) throw invalid;
  if (coupon.validFrom && coupon.validFrom > now) throw invalid;
  if (coupon.validUntil && coupon.validUntil <= now)
    throw new BadRequestError("That coupon has expired.");
  if (coupon.planIds && !coupon.planIds.includes(planId))
    throw new BadRequestError("That coupon doesn't apply to this plan.");
  if (coupon.maxRedemptions !== null && coupon.redemptions >= coupon.maxRedemptions)
    throw new BadRequestError("That coupon has been used up.");
  return coupon;
}

export async function previewCoupon(
  ctx: BillingContext,
  code: string,
  planId: PlanId,
): Promise<CouponPreview> {
  return ctx.db.transaction(async (tx) => {
    const coupon = await validCoupon(tx, code, planId, ctx.now());
    return { code: coupon.code, description: coupon.description };
  });
}

// ── Managing a subscription ────────────────────────────────────────────────────────────────

/** The subscription, if the caller may manage it: the purchaser or the team's owner/admin. */
async function managedSubscription(tx: Tx, userId: string, subscriptionId: string) {
  const [row] = await tx
    .select({ sub: subscriptions, orgRole: memberships.role })
    .from(subscriptions)
    .leftJoin(
      memberships,
      and(eq(memberships.orgId, subscriptions.orgId), eq(memberships.userId, userId)),
    )
    .where(eq(subscriptions.id, subscriptionId))
    .for("update", { of: subscriptions });
  if (!row) throw new NotFoundError("Subscription not found");
  const allowed = row.sub.userId === userId || row.orgRole === "owner" || row.orgRole === "admin";
  if (!allowed)
    throw new ForbiddenError("Only the person who manages this subscription can change it.");
  return row.sub;
}

export async function cancelSubscription(
  ctx: BillingContext,
  user: AuthUser,
  subscriptionId: string,
  ip: string,
): Promise<void> {
  const config = requireBilling(ctx);
  const effects = noEffects();
  await ctx.db.transaction(async (tx) => {
    const sub = await managedSubscription(tx, user.id, subscriptionId);
    await lockKey(tx, `billing-sub:${sub.provider}:${sub.providerSubscriptionId}`);
    if (sub.cancelAtPeriodEnd) return; // already cancelled: idempotent
    if (!(["authenticated", "active"] as SubscriptionStatus[]).includes(sub.status))
      throw new ConflictError("Only an active subscription can be cancelled.");
    try {
      await config.provider.cancel(sub.providerSubscriptionId);
    } catch (error) {
      throw providerFailure(error, "cancel the subscription");
    }
    const [updated] = await tx
      .update(subscriptions)
      .set({ cancelAtPeriodEnd: true, nextChargeAt: null, updatedAt: ctx.now() })
      .where(eq(subscriptions.id, sub.id))
      .returning();
    if (!updated) throw new Error("subscription update failed");
    const tier = await tierOf(tx, updated.planId);
    for (const userId of await refreshSubscriptionGrants(tx, updated, tier, ctx.now()))
      effects.revocations.push(...(await enforceOwnerLimits(tx, userId, ctx.now())));
    await audit(tx, {
      action: "billing.cancel",
      actorId: user.id,
      orgId: sub.orgId,
      targetType: "subscription",
      targetId: sub.id,
      metadata: { planId: sub.planId, endsAt: sub.currentPeriodEnd?.toISOString() ?? null },
      ip,
    });
  });
  await runEffects(ctx, effects);
}

async function tierOf(tx: Pick<Tx, "select">, planId: string): Promise<Plan> {
  const [plan] = await tx.select({ tier: plans.tier }).from(plans).where(eq(plans.id, planId));
  if (!plan) throw new Error(`plan ${planId} missing`);
  return plan.tier;
}

/**
 * Monthly ↔ yearly and seat changes within the same tier. More per year = an upgrade, applied
 * now (the provider charges it); less = applied when the paid period ends, so nobody loses
 * time they paid for. Pro → Team is a new subscription for a team workspace, not a change.
 */
export async function changePlan(
  ctx: BillingContext,
  user: AuthUser,
  body: ChangePlanRequest,
  ip: string,
): Promise<{ effective: "now" | "cycle_end" }> {
  const config = requireBilling(ctx);
  const result = await ctx.db.transaction(async (tx) => {
    const sub = await managedSubscription(tx, user.id, body.subscriptionId);
    await lockKey(tx, `billing-sub:${sub.provider}:${sub.providerSubscriptionId}`);
    if (
      !(["authenticated", "active"] as SubscriptionStatus[]).includes(sub.status) ||
      sub.cancelAtPeriodEnd
    )
      throw new ConflictError("Only an active, renewing subscription can be changed.");
    const [current] = await tx.select().from(plans).where(eq(plans.id, sub.planId));
    const next = await catalogPlan(tx, body.planId);
    if (current?.tier !== next.tier)
      throw new BadRequestError(
        next.tier === "team"
          ? "Team is billed to a team workspace: start a Team subscription, then cancel Pro."
          : "To move from Team to Pro, cancel Team and subscribe to Pro.",
      );
    const quantity = next.tier === "team" ? (body.seats ?? sub.quantity) : 1;
    if (next.tier === "team" && quantity < 2)
      throw new BadRequestError("A team needs at least 2 seats.");
    if (next.tier === "team" && sub.orgId) {
      const [members] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(memberships)
        .where(eq(memberships.orgId, sub.orgId));
      if ((members?.n ?? 0) > quantity)
        throw new ConflictError(
          `The team has ${String(members?.n ?? 0)} members. Remove members before reducing seats.`,
        );
    }
    if (body.planId === sub.planId && quantity === sub.quantity)
      throw new BadRequestError("That's already your plan.");
    const perYear = (plan: typeof next, seats: number) =>
      plan.amountMinor * seats * (plan.interval === "month" ? 12 : 1);
    const when = perYear(next, quantity) >= perYear(current, sub.quantity) ? "now" : "cycle_end";
    try {
      await config.provider.changePlan(sub.providerSubscriptionId, {
        providerPlanId: config.providerPlanIds[body.planId],
        quantity,
        when,
      });
    } catch (error) {
      throw providerFailure(
        error,
        "change the plan (subscriptions paid by UPI or e-mandate can't be changed; cancel and subscribe again)",
      );
    }
    await audit(tx, {
      action: "billing.change_plan",
      actorId: user.id,
      orgId: sub.orgId,
      targetType: "subscription",
      targetId: sub.id,
      metadata: {
        from: { planId: sub.planId, quantity: sub.quantity },
        to: { planId: body.planId, quantity },
        when,
      },
      ip,
    });
    return { effective: when, providerSubscriptionId: sub.providerSubscriptionId } as const;
  });
  // Apply the provider's new state right away (the webhook will confirm it, idempotently).
  await syncSubscription(ctx, result.providerSubscriptionId).catch((error: unknown) => {
    ctx.logger.warn(
      { err: error },
      "billing: sync after plan change failed; the webhook will apply it",
    );
  });
  return { effective: result.effective };
}

/**
 * After checkout, the browser asks us to fetch the caller's subscriptions from the provider,
 * so features unlock without waiting for the webhook (and local development works without
 * a public webhook URL). The same idempotent path as webhooks.
 */
export async function refreshMySubscriptions(ctx: BillingContext, userId: string): Promise<void> {
  requireBilling(ctx);
  const mine = await ctx.db
    .select({ providerSubscriptionId: subscriptions.providerSubscriptionId })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        inArray(subscriptions.status, ["created", ...LIVE_SUBSCRIPTION_STATUSES]),
      ),
    );
  for (const { providerSubscriptionId } of mine) {
    try {
      await syncSubscription(ctx, providerSubscriptionId);
    } catch (error) {
      throw providerFailure(error, "report the subscription");
    }
  }
}

// ── Student offer ──────────────────────────────────────────────────────────────────────────

export function emailHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

export async function startStudentTrial(
  ctx: BillingContext,
  user: AuthUser,
  ip: string,
): Promise<Date> {
  if (!user.email || !isStudentEmail(user.email))
    throw new ForbiddenError(
      "The student offer needs a university email address (.edu or .ac.in). Sign in with it to claim the offer.",
    );
  const email = user.email;
  const now = ctx.now();
  const endsAt = new Date(now);
  endsAt.setUTCMonth(endsAt.getUTCMonth() + STUDENT_TRIAL_MONTHS);
  const effects = noEffects();
  await ctx.db.transaction(async (tx) => {
    await ensureWorkspace(tx, user);
    const [trial] = await tx
      .insert(studentTrials)
      .values({ userId: user.id, emailHash: emailHash(email), startedAt: now, endsAt })
      .onConflictDoNothing()
      .returning({ id: studentTrials.id });
    if (!trial)
      throw new ConflictError(
        "The student offer has already been used with this account or email.",
      );
    await upsertGrant(tx, {
      userId: user.id,
      plan: "pro",
      source: "student_trial",
      sourceId: trial.id,
      validUntil: endsAt,
    });
    effects.revocations.push(...(await enforceOwnerLimits(tx, user.id, now)));
    await audit(tx, {
      action: "billing.student_trial",
      actorId: user.id,
      targetType: "entitlement",
      targetId: trial.id,
      metadata: { endsAt: endsAt.toISOString() },
      ip,
    });
  });
  await runEffects(ctx, effects);
  return endsAt;
}

// ── Sweep (cron) ──────────────────────────────────────────────────────────────────────────

export interface SweepResult {
  resynced: number;
  reminders: number;
  expired: number;
}

/**
 * Periodic job (Render Cron → POST /internal/billing-sweep). Safe to run at any frequency or
 * twice at once: every step is idempotent and marks what it did in the same transaction.
 * Entitlement checks never wait for it (expiry is compared at every check); it enforces
 * limits on the boards themselves and sends the reminder and downgrade emails.
 */
export async function runBillingSweep(ctx: BillingContext): Promise<SweepResult> {
  const now = ctx.now();
  const result: SweepResult = { resynced: 0, reminders: 0, expired: 0 };

  // 1. Missed webhooks: renewing subscriptions past their period end are fetched again.
  if (ctx.billing) {
    const stale = await ctx.db
      .select({ id: subscriptions.providerSubscriptionId })
      .from(subscriptions)
      .where(
        and(
          inArray(subscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]),
          sql`${subscriptions.currentPeriodEnd} < ${new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString()}::timestamptz`,
          sql`(${subscriptions.syncedAt} is null or ${subscriptions.syncedAt} < ${new Date(now.getTime() - 60 * 60 * 1000).toISOString()}::timestamptz)`,
        ),
      )
      .limit(50);
    for (const { id } of stale) {
      try {
        await syncSubscription(ctx, id);
        result.resynced += 1;
      } catch (error) {
        ctx.logger.warn({ err: error, providerSubscriptionId: id }, "billing sweep: resync failed");
      }
    }
  }

  // 2. Grace-period reminders, once per failure episode.
  const reminderFrom = new Date(now.getTime() + 2 * DAY_MS).toISOString();
  const due = await ctx.db
    .update(subscriptions)
    .set({ graceReminderSentAt: now })
    .where(
      and(
        inArray(subscriptions.status, ["past_due", "halted"]),
        sql`${subscriptions.graceReminderSentAt} is null`,
        sql`${subscriptions.graceUntil} > ${now.toISOString()}::timestamptz`,
        sql`${subscriptions.graceUntil} <= ${reminderFrom}::timestamptz`,
      ),
    )
    .returning();
  for (const sub of due) {
    const email = sub.userId ? await emailOf(ctx.db, sub.userId) : null;
    if (!email || !sub.graceUntil) continue;
    const tier = await tierOf(ctx.db, sub.planId);
    const graceUntil = sub.graceUntil;
    await runEffects(ctx, {
      revocations: [],
      emails: [
        () =>
          graceReminderEmail(email, {
            plan: tier,
            graceUntil,
            paymentUrl: null,
            billingUrl: `${ctx.appUrl}/app/settings/billing`,
          }),
      ],
    });
    result.reminders += 1;
  }

  // 3. Grants that ended: enforce the lower limits and tell the user, once.
  const expired = await ctx.db
    .select({ id: entitlements.id, userId: entitlements.userId, plan: entitlements.plan })
    .from(entitlements)
    .where(
      and(
        sql`${entitlements.validUntil} <= ${now.toISOString()}::timestamptz`,
        sql`${entitlements.expiryProcessedAt} is null`,
      ),
    )
    .limit(200);
  for (const grant of expired) {
    const effects = noEffects();
    await ctx.db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(entitlements)
        .set({ expiryProcessedAt: now })
        .where(and(eq(entitlements.id, grant.id), sql`${entitlements.expiryProcessedAt} is null`))
        .returning({ id: entitlements.id });
      if (!claimed) return; // another sweep got it
      effects.revocations.push(...(await enforceOwnerLimits(tx, grant.userId, now)));
      const after = effectiveEntitlement(await loadGrants(tx, grant.userId), now);
      if (PLAN_RANK[after.plan] >= PLAN_RANK[grant.plan]) return; // still covered by another grant
      const email = await emailOf(tx, grant.userId);
      const [locked] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(boards)
        .where(
          and(
            eq(boards.ownerId, grant.userId),
            sql`${boards.planLockedAt} is not null and ${boards.deletedAt} is null`,
          ),
        );
      await audit(tx, {
        action: "billing.downgrade",
        actorId: null,
        targetType: "entitlement",
        targetId: grant.id,
        metadata: {
          userId: grant.userId,
          from: grant.plan,
          to: after.plan,
          lockedBoards: locked?.n ?? 0,
        },
      });
      if (email)
        effects.emails.push(() =>
          downgradedEmail(email, {
            previousPlan: grant.plan,
            lockedBoards: locked?.n ?? 0,
            pricingUrl: `${ctx.appUrl}/pricing`,
          }),
        );
    });
    await runEffects(ctx, effects);
    result.expired += 1;
  }
  return result;
}

// ── Summary ────────────────────────────────────────────────────────────────────────────────

export async function billingSummary(ctx: BillingContext, user: AuthUser): Promise<BillingSummary> {
  const now = ctx.now();
  const db = ctx.db;
  const entitlement = await loadEntitlement(db, user.id, now);
  const orgRows = await db
    .select({
      orgId: memberships.orgId,
      role: memberships.role,
      name: organizations.name,
      kind: organizations.kind,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(eq(memberships.userId, user.id));
  const managedOrgIds = orgRows
    .filter((org) => org.role === "owner" || org.role === "admin")
    .map((org) => org.orgId);

  const subRows = await db
    .select({ sub: subscriptions, plan: plans, orgName: organizations.name })
    .from(subscriptions)
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .leftJoin(organizations, eq(organizations.id, subscriptions.orgId))
    .where(
      and(
        sql`(${subscriptions.userId} = ${user.id}${managedOrgIds.length > 0 ? sql` or ${inArray(subscriptions.orgId, managedOrgIds)}` : sql``})`,
        sql`(${subscriptions.status} <> 'created' or ${subscriptions.createdAt} > now() - interval '1 day')`,
        sql`${subscriptions.status} not in ('expired')`,
      ),
    )
    .orderBy(desc(subscriptions.createdAt))
    .limit(20);

  const subIds = subRows.map((row) => row.sub.id);
  const invoiceRows =
    subIds.length === 0
      ? []
      : await db
          .select()
          .from(invoices)
          .where(inArray(invoices.subscriptionId, subIds))
          .orderBy(desc(invoices.issuedAt))
          .limit(50);

  const [boardCounts] = await db
    .select({
      boards: sql<number>`count(*)::int`,
      locked: sql<number>`count(*) filter (where ${boards.planLockedAt} is not null)::int`,
    })
    .from(boards)
    .where(and(eq(boards.ownerId, user.id), sql`${boards.deletedAt} is null`));

  const [trial] = await db
    .select({ endsAt: studentTrials.endsAt })
    .from(studentTrials)
    .where(eq(studentTrials.userId, user.id));
  const trialUsedByEmail = user.email
    ? (
        await db
          .select({ id: studentTrials.id })
          .from(studentTrials)
          .where(eq(studentTrials.emailHash, emailHash(user.email)))
      ).length > 0
    : true;

  const iso = (date: Date | null) => date?.toISOString() ?? null;
  return {
    plan: entitlement.plan,
    source: entitlement.source,
    validUntil: iso(entitlement.validUntil),
    subscriptions: subRows.map(({ sub, plan, orgName }) => ({
      id: sub.id,
      orgId: sub.orgId,
      orgName,
      planId: sub.planId as PlanId,
      tier: plan.tier,
      status: sub.status,
      seats: sub.quantity,
      currentPeriodEnd: iso(sub.currentPeriodEnd),
      nextChargeAt: iso(sub.nextChargeAt),
      nextChargeMinor: sub.nextChargeAt ? plan.amountMinor * sub.quantity : null,
      currency: plan.currency,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      graceUntil: iso(sub.graceUntil),
      canManage:
        sub.userId === user.id || (sub.orgId !== null && managedOrgIds.includes(sub.orgId)),
      scheduledChange: sub.hasScheduledChange,
    })),
    invoices: invoiceRows.map((invoice) => ({
      id: invoice.id,
      status: invoice.status,
      amountMinor: invoice.amountMinor,
      currency: invoice.currency,
      issuedAt: iso(invoice.issuedAt),
      paidAt: iso(invoice.paidAt),
      periodStart: iso(invoice.periodStart),
      periodEnd: iso(invoice.periodEnd),
      receiptUrl: invoice.receiptUrl,
    })),
    usage: {
      boards: boardCounts?.boards ?? 0,
      boardLimit: entitlement.limits.boards,
      lockedBoards: boardCounts?.locked ?? 0,
      aiReviewsUsed: await reviewsUsed(db, user.id, entitlement),
      aiReviewsLimit: entitlement.reviewsPerMonth,
      editorsPerBoard: entitlement.limits.editorsPerBoard,
    },
    studentTrial: {
      eligible: !trial && !trialUsedByEmail && user.email !== null && isStudentEmail(user.email),
      activeUntil: trial && trial.endsAt > now ? trial.endsAt.toISOString() : null,
    },
    teams: orgRows
      .filter((org) => org.kind === "team")
      .map((org) => ({ orgId: org.orgId, name: org.name, role: org.role })),
    checkoutAvailable: ctx.billing !== undefined,
  };
}
