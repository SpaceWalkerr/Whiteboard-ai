import { PLAN_IDS } from "@whiteboard/shared/billing";
import {
  nextGrace,
  subscriptionValidUntil,
  type Plan,
  type SubscriptionStatus,
} from "@whiteboard/shared/entitlements";
import {
  and,
  asc,
  billingEvents,
  coupons,
  desc,
  entitlements,
  eq,
  invoices,
  memberships,
  organizations,
  plans,
  profiles,
  sql,
  subscriptions,
  type SubscriptionRow,
} from "@whiteboard/shared/db";
import type { Tx } from "../api/deps";
import { audit } from "../audit/audit";
import { paymentFailedEmail, receiptEmail } from "../email/BillingEmails";
import {
  noEffects,
  planIdForProvider,
  runEffects,
  type BillingConfig,
  type BillingContext,
  type Effects,
} from "./context";
import { endGrant, upsertGrant } from "./entitlements";
import { enforceOwnerLimits, lockKey } from "./limits";
import type { ProviderInvoice, ProviderSubscription, WebhookEvent } from "./provider";

const FAILED: readonly SubscriptionStatus[] = ["past_due", "halted"];
const PAID: readonly SubscriptionStatus[] = ["authenticated", "active"];

export type SyncOutcome = "applied" | "unchanged" | "duplicate" | "unknown";

/**
 * Makes our copy of a subscription match the provider, and everything derived from it
 * (grants, board locks, editor seats, invoices) match that. The single path for webhooks,
 * the post-checkout refresh and the sweep.
 *
 * Correct under retries and reordering by construction:
 * - a webhook's event id is inserted first, in the same transaction as every effect, so a
 *   redelivery conflicts and changes nothing (and a failure rolls the id back → retried);
 * - the state applied is fetched from the provider inside a per-subscription lock, never
 *   read from the event, so the order events arrive in doesn't matter;
 * - emails and socket re-checks run only after commit.
 */
export async function syncSubscription(
  ctx: BillingContext,
  providerSubscriptionId: string,
  event?: WebhookEvent,
): Promise<SyncOutcome> {
  const config = ctx.billing;
  if (!config) throw new Error("billing is not configured");
  const provider = config.provider;
  const effects = noEffects();
  const outcome = await ctx.db.transaction(async (tx) => {
    await lockKey(tx, `billing-sub:${provider.name}:${providerSubscriptionId}`);
    if (event) {
      const inserted = await tx
        .insert(billingEvents)
        .values({
          provider: provider.name,
          providerEventId: event.id,
          eventType: event.type,
          providerSubscriptionId,
        })
        .onConflictDoNothing()
        .returning({ id: billingEvents.id });
      if (inserted.length === 0) return "duplicate" as const;
    }
    const remote = await provider.getSubscription(providerSubscriptionId);
    const remoteInvoices = await provider.listInvoices(providerSubscriptionId);
    return applyRemote(tx, ctx, config, remote, remoteInvoices, effects, event);
  });
  await runEffects(ctx, effects);
  return outcome;
}

async function applyRemote(
  tx: Tx,
  ctx: BillingContext,
  config: BillingConfig,
  remote: ProviderSubscription,
  remoteInvoices: ProviderInvoice[],
  effects: Effects,
  event: WebhookEvent | undefined,
): Promise<SyncOutcome> {
  const now = ctx.now();
  const provider = config.provider.name;
  const [local] = await tx
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.provider, provider),
        eq(subscriptions.providerSubscriptionId, remote.id),
      ),
    )
    .for("update");

  const owner = local
    ? { orgId: local.orgId, userId: local.userId }
    : await ownerFromNotes(tx, remote);
  if (!owner) {
    ctx.logger.warn(
      { providerSubscriptionId: remote.id, event: event?.type },
      "billing: subscription is not ours (no local row, no valid notes); ignored",
    );
    return "unknown";
  }

  const planId = planIdForProvider(config, remote.providerPlanId) ?? local?.planId;
  if (!planId) throw new Error(`billing: unknown provider plan ${remote.providerPlanId}`);
  const [plan] = await tx
    .select({ tier: plans.tier, amountMinor: plans.amountMinor, currency: plans.currency })
    .from(plans)
    .where(eq(plans.id, planId));
  if (!plan) throw new Error(`billing: plan ${planId} missing from the catalog`);

  const previousStatus = local?.status ?? null;
  const graceUntil = nextGrace(
    { status: previousStatus, graceUntil: local?.graceUntil ?? null },
    remote.status,
    now,
  );
  // Our own cancel request; the provider keeps the subscription "active" until the cycle ends.
  const cancelAtPeriodEnd = (local?.cancelAtPeriodEnd ?? false) && PAID.includes(remote.status);
  const values = {
    planId,
    status: remote.status,
    quantity: remote.quantity,
    providerCustomerId: remote.customerId,
    currentPeriodStart: remote.currentPeriodStart,
    currentPeriodEnd: remote.currentPeriodEnd,
    nextChargeAt: cancelAtPeriodEnd || !PAID.includes(remote.status) ? null : remote.nextChargeAt,
    endedAt: remote.endedAt,
    hasScheduledChange: remote.hasScheduledChange,
    cancelAtPeriodEnd,
    graceUntil,
    // A new failure episode gets a new reminder.
    graceReminderSentAt: graceUntil === null ? null : (local?.graceReminderSentAt ?? null),
    syncedAt: now,
    updatedAt: now,
  };
  let row: SubscriptionRow;
  if (local) {
    const [updated] = await tx
      .update(subscriptions)
      .set(values)
      .where(eq(subscriptions.id, local.id))
      .returning();
    if (!updated) throw new Error("subscription update failed");
    row = updated;
  } else {
    const [inserted] = await tx
      .insert(subscriptions)
      .values({
        ...values,
        orgId: owner.orgId,
        userId: owner.userId,
        provider,
        providerSubscriptionId: remote.id,
      })
      .returning();
    if (!inserted) throw new Error("subscription insert failed");
    row = inserted;
  }

  const changed =
    local?.status !== row.status ||
    local.planId !== row.planId ||
    local.quantity !== row.quantity ||
    local.currentPeriodEnd?.getTime() !== row.currentPeriodEnd?.getTime() ||
    local.graceUntil?.getTime() !== row.graceUntil?.getTime();

  await redeemCoupon(tx, row, now);
  const email = row.userId ? await emailOf(tx, row.userId) : null;
  const billingUrl = `${ctx.appUrl}/app/settings/billing`;

  // Invoices: upsert, then send each paid invoice's receipt exactly once.
  for (const invoice of remoteInvoices) await upsertInvoice(tx, row, provider, invoice);
  const unsentReceipts = await tx
    .update(invoices)
    .set({ receiptSentAt: now })
    .where(
      and(
        eq(invoices.subscriptionId, row.id),
        eq(invoices.status, "paid"),
        sql`${invoices.receiptSentAt} is null`,
      ),
    )
    .returning();
  if (email) {
    for (const invoice of unsentReceipts) {
      const tier = plan.tier;
      effects.emails.push(() =>
        receiptEmail(email, {
          plan: tier,
          amountMinor: invoice.amountMinor,
          currency: invoice.currency,
          paidAt: invoice.paidAt ?? now,
          periodEnd: invoice.periodEnd,
          receiptUrl: invoice.receiptUrl,
          billingUrl,
        }),
      );
    }
  }

  // Payment failed: once per failure episode (entering the grace period).
  if (
    email &&
    row.graceUntil &&
    FAILED.includes(row.status) &&
    !(previousStatus !== null && FAILED.includes(previousStatus))
  ) {
    const graceUntil = row.graceUntil;
    const tier = plan.tier;
    effects.emails.push(() =>
      paymentFailedEmail(email, {
        plan: tier,
        graceUntil,
        paymentUrl: remote.paymentUrl,
        billingUrl,
      }),
    );
  }

  const affected = await refreshSubscriptionGrants(tx, row, plan.tier, now);
  for (const userId of affected)
    effects.revocations.push(...(await enforceOwnerLimits(tx, userId, now)));

  if (changed || event) {
    await audit(tx, {
      action: "billing.subscription_sync",
      actorId: null,
      orgId: row.orgId,
      targetType: "subscription",
      targetId: row.id,
      metadata: {
        event: event?.type ?? "refresh",
        eventId: event?.id ?? null,
        from: local
          ? { status: local.status, planId: local.planId, quantity: local.quantity }
          : null,
        to: { status: row.status, planId: row.planId, quantity: row.quantity },
      },
    });
  }
  return changed ? "applied" : "unchanged";
}

/**
 * Grants a subscription gives: Pro → the purchaser; Team → the workspace's members up to the
 * seat count (owner first, then by join date). Returns every user whose grants were touched.
 */
export async function refreshSubscriptionGrants(
  tx: Tx,
  sub: SubscriptionRow,
  tier: Plan,
  now: Date,
): Promise<string[]> {
  const validUntil = subscriptionValidUntil(sub);
  if (tier !== "team") {
    if (!sub.userId) return [];
    if (validUntil === false)
      await endGrant(tx, { userId: sub.userId, source: "subscription", sourceId: sub.id }, now);
    else
      await upsertGrant(tx, {
        userId: sub.userId,
        plan: tier,
        source: "subscription",
        sourceId: sub.id,
        validUntil,
      });
    return [sub.userId];
  }
  if (!sub.orgId) return [];
  const members = await teamMembersInSeatOrder(tx, sub.orgId);
  const touched: string[] = [];
  for (const [index, userId] of members.entries()) {
    touched.push(userId);
    if (validUntil === false || index >= sub.quantity)
      await endGrant(tx, { userId, source: "team_seat", sourceId: sub.id }, now);
    else
      await upsertGrant(tx, {
        userId,
        plan: "team",
        source: "team_seat",
        sourceId: sub.id,
        validUntil,
        orgId: sub.orgId,
        seats: sub.quantity,
      });
  }
  // People who left the workspace lose their seat.
  const holders = await tx
    .select({ userId: entitlements.userId })
    .from(entitlements)
    .where(and(eq(entitlements.source, "team_seat"), eq(entitlements.sourceId, sub.id)));
  for (const { userId } of holders) {
    if (members.includes(userId)) continue;
    await endGrant(tx, { userId, source: "team_seat", sourceId: sub.id }, now);
    touched.push(userId);
  }
  return touched;
}

/** Re-derives a team's seats after its membership changed. Returns users to enforce limits for. */
export async function refreshTeamSeats(tx: Tx, orgId: string, now: Date): Promise<string[]> {
  const [sub] = await tx
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.orgId, orgId))
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);
  if (!sub) return [];
  const [plan] = await tx.select({ tier: plans.tier }).from(plans).where(eq(plans.id, sub.planId));
  if (plan?.tier !== "team") return [];
  return refreshSubscriptionGrants(tx, sub, "team", now);
}

export async function teamMembersInSeatOrder(tx: Tx, orgId: string): Promise<string[]> {
  const rows = await tx
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(eq(memberships.orgId, orgId))
    .orderBy(
      sql`case ${memberships.role} when 'owner' then 0 when 'admin' then 1 else 2 end`,
      asc(memberships.createdAt),
      asc(memberships.userId),
    );
  return rows.map((row) => row.userId);
}

async function upsertInvoice(
  tx: Tx,
  sub: SubscriptionRow,
  provider: SubscriptionRow["provider"],
  invoice: ProviderInvoice,
): Promise<void> {
  const values = {
    status: invoice.status,
    amountMinor: invoice.amountMinor,
    currency: invoice.currency,
    providerPaymentId: invoice.paymentId,
    periodStart: invoice.periodStart,
    periodEnd: invoice.periodEnd,
    issuedAt: invoice.issuedAt,
    paidAt: invoice.paidAt,
    receiptUrl: invoice.receiptUrl,
  };
  await tx
    .insert(invoices)
    .values({
      ...values,
      subscriptionId: sub.id,
      orgId: sub.orgId,
      userId: sub.userId,
      provider,
      providerInvoiceId: invoice.id,
    })
    .onConflictDoUpdate({
      target: [invoices.provider, invoices.providerInvoiceId],
      set: { ...values, updatedAt: sql`now()` },
    });
}

/** Counts a coupon once, when its subscription is first paid for. */
async function redeemCoupon(tx: Tx, sub: SubscriptionRow, now: Date): Promise<void> {
  if (!sub.couponCode || sub.couponRedeemedAt || !PAID.includes(sub.status)) return;
  await tx
    .update(coupons)
    .set({ redemptions: sql`${coupons.redemptions} + 1` })
    .where(eq(coupons.code, sub.couponCode));
  await tx.update(subscriptions).set({ couponRedeemedAt: now }).where(eq(subscriptions.id, sub.id));
}

/**
 * A subscription we have no row for (our insert after checkout was lost): adopt it only if
 * the notes we attached at checkout name a real workspace and member.
 */
async function ownerFromNotes(
  tx: Tx,
  remote: ProviderSubscription,
): Promise<{ orgId: string; userId: string } | null> {
  const { orgId, userId, planId } = remote.notes;
  if (!orgId || !userId || !planId || !(PLAN_IDS as readonly string[]).includes(planId))
    return null;
  if (!/^[0-9a-f-]{36}$/i.test(orgId) || !/^[0-9a-f-]{36}$/i.test(userId)) return null;
  const [member] = await tx
    .select({ orgId: memberships.orgId })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
  return member ? { orgId, userId } : null;
}

export async function emailOf(tx: Pick<Tx, "select">, userId: string): Promise<string | null> {
  const [row] = await tx
    .select({ email: profiles.email })
    .from(profiles)
    .where(eq(profiles.id, userId));
  return row?.email ?? null;
}
