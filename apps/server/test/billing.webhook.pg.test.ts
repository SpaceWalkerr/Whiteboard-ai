// Phase 10: money logic under retries, reordering and failures — the real webhook route, real
// Postgres, a scripted provider. The provider's current state is the only truth applied.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  auditLogs,
  billingEvents,
  boards,
  count,
  entitlements,
  eq,
  inArray,
  invoices,
  sql as dsql,
  subscriptions,
  type Database,
  type SqlClient,
} from "@whiteboard/shared/db";
import {
  createAuthUser,
  createTestAuth,
  deleteAuthUsers,
  startApiServer,
  type ApiServer,
  type TestUser,
} from "./authHelpers";
import {
  fakeBilling,
  newEventId,
  nth,
  sendWebhook,
  TestClock,
  type FakeBillingProvider,
} from "./billingHelpers";
import { connectTestDb } from "./pgHelpers";

const CRON = "c".repeat(40);

let db: Database;
let sql: SqlClient;
let auth: Awaited<ReturnType<typeof createTestAuth>>;
let server: ApiServer;
let started = false;
let fake: FakeBillingProvider;
let clock: TestClock;
const userIds: string[] = [];
const providerIds: string[] = [];

interface Customer {
  user: TestUser;
  token: string;
  subscriptionId: string;
  providerId: string;
}

async function newUser(name: string): Promise<{ user: TestUser; token: string }> {
  const user = await createAuthUser(sql, name);
  userIds.push(user.id);
  const token = await auth.sign(user);
  expect((await server.request("POST", "/me/bootstrap", { token })).status).toBe(200);
  return { user, token };
}

async function checkout(token: string, body: Record<string, unknown>) {
  return server.request("POST", "/billing/checkout", { token, body });
}

/** A user who went through checkout and paid (activated + charged webhooks). */
async function subscribed(name: string, planId = "pro_monthly", seats?: number): Promise<Customer> {
  const { user, token } = await newUser(name);
  const res = await checkout(token, { planId, ...(seats ? { seats } : {}) });
  expect(res.status).toBe(200);
  const body = res.body as { subscriptionId: string; razorpay: { subscriptionId: string } };
  providerIds.push(body.razorpay.subscriptionId);
  fake.charge(body.razorpay.subscriptionId, clock.now());
  expect(
    (
      await sendWebhook(server, {
        type: "subscription.activated",
        subscriptionId: body.razorpay.subscriptionId,
      })
    ).status,
  ).toBe(200);
  return {
    user,
    token,
    subscriptionId: body.subscriptionId,
    providerId: body.razorpay.subscriptionId,
  };
}

async function planOf(token: string): Promise<string> {
  const res = await server.request("GET", "/billing", { token });
  expect(res.status).toBe(200);
  return (res.body as { plan: string }).plan;
}

async function subRow(id: string) {
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, id));
  if (!row) throw new Error("subscription missing");
  return row;
}

/** Everything a webhook can change, for "changes nothing" comparisons. */
async function snapshot(customer: Customer) {
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, customer.subscriptionId));
  const grants = await db
    .select()
    .from(entitlements)
    .where(eq(entitlements.userId, customer.user.id));
  const bills = await db
    .select()
    .from(invoices)
    .where(eq(invoices.subscriptionId, customer.subscriptionId));
  const [events] = await db
    .select({ n: count() })
    .from(billingEvents)
    .where(eq(billingEvents.providerSubscriptionId, customer.providerId));
  const [audits] = await db
    .select({ n: count() })
    .from(auditLogs)
    .where(eq(auditLogs.targetId, customer.subscriptionId));
  return JSON.stringify({ sub, grants, bills, events, audits, mails: server.mailer.sent.length });
}

async function createBoards(token: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const res = await server.request("POST", "/boards", {
      token,
      body: { title: `B${String(i)}` },
    });
    expect(res.status).toBe(201);
    ids.push((res.body as { id: string }).id);
    // Distinct updated_at, so "most recently edited" is well defined.
    await db
      .update(boards)
      .set({ updatedAt: new Date(Date.now() - (n - i) * 60_000) })
      .where(eq(boards.id, (res.body as { id: string }).id));
  }
  return ids;
}

async function sweep() {
  const res = await server.request("POST", "/internal/billing-sweep", {
    headers: { authorization: `Bearer ${CRON}` },
  });
  expect(res.status).toBe(200);
  return res.body as { resynced: number; reminders: number; expired: number };
}

beforeAll(async () => {
  ({ db, sql } = await connectTestDb());
  auth = await createTestAuth();
});

beforeEach(async () => {
  const billing = fakeBilling();
  fake = billing.provider;
  clock = new TestClock();
  if (started) await server.stop();
  started = true;
  server = await startApiServer(db, auth.verifier, {
    billing: billing.config,
    now: clock.now,
    cronSecret: CRON,
  });
});

afterAll(async () => {
  await server.stop();
  if (providerIds.length > 0) {
    await sql`delete from invoices where subscription_id in
      (select id from subscriptions where provider_subscription_id = any(${providerIds}))`;
    await db
      .delete(billingEvents)
      .where(inArray(billingEvents.providerSubscriptionId, providerIds));
    await db
      .delete(subscriptions)
      .where(inArray(subscriptions.providerSubscriptionId, providerIds));
  }
  await deleteAuthUsers(sql, userIds);
  await sql.end();
});

describe("subscribing", () => {
  it("activates Pro from the provider's state, stores the invoice and emails a receipt once", async () => {
    const c = await subscribed("Buyer");
    expect(await planOf(c.token)).toBe("pro");
    const row = await subRow(c.subscriptionId);
    expect(row.status).toBe("active");
    const bills = await db
      .select()
      .from(invoices)
      .where(eq(invoices.subscriptionId, c.subscriptionId));
    expect(bills).toHaveLength(1);
    expect(bills[0]?.status).toBe("paid");
    expect(server.mailer.sent.filter((m) => m.subject.startsWith("Payment received"))).toHaveLength(
      1,
    );
    // A second charge event for the same payment: still one receipt.
    await sendWebhook(server, { type: "subscription.charged", subscriptionId: c.providerId });
    expect(server.mailer.sent.filter((m) => m.subject.startsWith("Payment received"))).toHaveLength(
      1,
    );
  });

  it("reuses an unpaid checkout on a double click and refuses a second subscription", async () => {
    const { token } = await newUser("Clicker");
    const a = await checkout(token, { planId: "pro_monthly" });
    const b = await checkout(token, { planId: "pro_monthly" });
    expect((a.body as { subscriptionId: string }).subscriptionId).toBe(
      (b.body as { subscriptionId: string }).subscriptionId,
    );
    const providerId = (a.body as { razorpay: { subscriptionId: string } }).razorpay.subscriptionId;
    providerIds.push(providerId);
    expect(fake.calls.filter((c) => c.method === "createCheckout")).toHaveLength(1);
    fake.charge(providerId, clock.now());
    await server.request("POST", "/billing/refresh", { token });
    expect(await planOf(token)).toBe("pro");
    expect((await checkout(token, { planId: "pro_yearly" })).status).toBe(409);
  });
});

describe("webhook idempotency and ordering", () => {
  it("replaying the same event 5 times changes nothing after the first", async () => {
    const c = await subscribed("Replay");
    const eventId = newEventId();
    fake.status(c.providerId, "past_due");
    const first = await sendWebhook(server, {
      id: eventId,
      type: "subscription.pending",
      subscriptionId: c.providerId,
    });
    expect(first.body).toMatchObject({ outcome: "applied" });
    const after = await snapshot(c);
    // Even if the provider's state moves on, a replayed id must not be applied again.
    fake.status(c.providerId, "halted");
    for (let i = 0; i < 4; i++) {
      const again = await sendWebhook(server, {
        id: eventId,
        type: "subscription.pending",
        subscriptionId: c.providerId,
      });
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ outcome: "duplicate" });
    }
    expect(await snapshot(c)).toBe(after);
    expect((await subRow(c.subscriptionId)).status).toBe("past_due");
  });

  it("applies the provider's current state whatever order events arrive in", async () => {
    const c = await subscribed("Order");
    // The subscription was cancelled at the provider; the "cancelled" event arrives first,
    // then a delayed older "charged" event.
    fake.set(c.providerId, {
      status: "cancelled",
      currentPeriodEnd: clock.at(-1),
      endedAt: clock.at(-1),
    });
    await sendWebhook(server, { type: "subscription.cancelled", subscriptionId: c.providerId });
    await sendWebhook(server, { type: "subscription.charged", subscriptionId: c.providerId });
    await sendWebhook(server, { type: "subscription.activated", subscriptionId: c.providerId });
    expect((await subRow(c.subscriptionId)).status).toBe("cancelled");
    expect(await planOf(c.token)).toBe("free");
  });

  it("serializes two different events for one subscription arriving together", async () => {
    const c = await subscribed("Parallel");
    fake.charge(c.providerId, clock.at(1));
    const results = await Promise.all([
      sendWebhook(server, { type: "subscription.charged", subscriptionId: c.providerId }),
      sendWebhook(server, { type: "invoice.paid", subscriptionId: c.providerId }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const bills = await db
      .select()
      .from(invoices)
      .where(eq(invoices.subscriptionId, c.subscriptionId));
    expect(bills).toHaveLength(2);
    expect(server.mailer.sent.filter((m) => m.subject.startsWith("Payment received"))).toHaveLength(
      2,
    );
  });

  it("rejects bad signatures, tampered bodies and missing event ids without storing anything", async () => {
    const c = await subscribed("Forger");
    const before = await snapshot(c);
    fake.status(c.providerId, "halted");
    const attempts = [
      await sendWebhook(
        server,
        { type: "subscription.halted", subscriptionId: c.providerId },
        { secret: "wrong-secret-0123456789" },
      ),
      await sendWebhook(
        server,
        { type: "subscription.halted", subscriptionId: c.providerId },
        { tamper: true },
      ),
      await sendWebhook(
        server,
        { type: "subscription.halted", subscriptionId: c.providerId },
        { omitEventId: true },
      ),
    ];
    expect(attempts.map((a) => a.status)).toEqual([400, 400, 400]);
    expect(await snapshot(c)).toBe(before);
    expect(await planOf(c.token)).toBe("pro");
  });

  it("answers 5xx when the provider can't be reached and applies the retry", async () => {
    const c = await subscribed("Outage");
    const eventId = newEventId();
    fake.status(c.providerId, "past_due");
    fake.failFetches = 1;
    const failed = await sendWebhook(server, {
      id: eventId,
      type: "subscription.pending",
      subscriptionId: c.providerId,
    });
    expect(failed.status).toBe(500);
    const [stored] = await db
      .select({ n: count() })
      .from(billingEvents)
      .where(eq(billingEvents.providerEventId, eventId));
    expect(stored?.n).toBe(0);
    const retried = await sendWebhook(server, {
      id: eventId,
      type: "subscription.pending",
      subscriptionId: c.providerId,
    });
    expect(retried.body).toMatchObject({ outcome: "applied" });
    expect((await subRow(c.subscriptionId)).status).toBe("past_due");
  });

  it("ignores events about subscriptions that aren't ours", async () => {
    fake.subs.set("sub_foreign1", {
      id: "sub_foreign1",
      customerId: null,
      providerPlanId: "plan_pro_m",
      status: "active",
      quantity: 1,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      nextChargeAt: null,
      endedAt: null,
      hasScheduledChange: false,
      offerId: null,
      paymentUrl: null,
      notes: {},
    });
    providerIds.push("sub_foreign1");
    const res = await sendWebhook(server, {
      type: "subscription.activated",
      subscriptionId: "sub_foreign1",
    });
    expect(res.body).toMatchObject({ outcome: "unknown" });
    const [row] = await db
      .select({ n: count() })
      .from(subscriptions)
      .where(eq(subscriptions.providerSubscriptionId, "sub_foreign1"));
    expect(row?.n).toBe(0);
  });
});

describe("failed payment → 7-day grace → Free", () => {
  it("keeps Pro through the grace period, reminds, then downgrades without deleting boards", async () => {
    const c = await subscribed("Late payer");
    const ids = await createBoards(c.token, 5);

    fake.status(c.providerId, "past_due");
    await sendWebhook(server, { type: "subscription.pending", subscriptionId: c.providerId });
    const row = await subRow(c.subscriptionId);
    expect(row.graceUntil?.getTime()).toBe(clock.at(7).getTime());
    expect(server.mailer.sent.filter((m) => m.subject.includes("didn't go through"))).toHaveLength(
      1,
    );
    expect(await planOf(c.token)).toBe("pro");

    // Retries fail again: the grace period doesn't restart, no second "failed" email.
    clock.advanceDays(3);
    fake.status(c.providerId, "halted");
    await sendWebhook(server, { type: "subscription.halted", subscriptionId: c.providerId });
    expect((await subRow(c.subscriptionId)).graceUntil?.getTime()).toBe(row.graceUntil?.getTime());
    expect(server.mailer.sent.filter((m) => m.subject.includes("didn't go through"))).toHaveLength(
      1,
    );

    clock.advanceDays(2); // day 5: 2 days left → reminder, once (other suites' rows may share the DB)
    await sweep();
    await sweep();
    expect(
      server.mailer.sent.filter(
        (m) => m.to === c.user.email && m.subject.startsWith("Action needed"),
      ),
    ).toHaveLength(1);

    clock.advanceDays(1); // day 6: still Pro, boards editable
    expect(await planOf(c.token)).toBe("pro");
    expect(
      (
        await server.request("PATCH", `/boards/${nth(ids, 0)}`, {
          token: c.token,
          body: { title: "ok" },
        })
      ).status,
    ).toBe(200);

    clock.advanceDays(2); // day 8: Free immediately, even before the sweep runs
    expect(await planOf(c.token)).toBe("free");
    expect(
      (await server.request("POST", "/boards", { token: c.token, body: {} })).body,
    ).toMatchObject({
      error: { code: "BOARD_LIMIT" },
    });

    expect((await sweep()).expired).toBeGreaterThanOrEqual(1);
    await sweep();
    const rows = await db
      .select({ id: boards.id, locked: boards.planLockedAt, deleted: boards.deletedAt })
      .from(boards)
      .where(inArray(boards.id, ids));
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.deleted === null)).toBe(true);
    const locked = rows
      .filter((r) => r.locked !== null)
      .map((r) => r.id)
      .sort();
    // The two least recently edited (ids[0] was renamed on day 6, so it's the newest).
    expect(locked).toEqual([nth(ids, 1), nth(ids, 2)].sort());
    expect(
      server.mailer.sent.filter(
        (m) => m.to === c.user.email && m.subject.includes("now on the Free plan"),
      ),
    ).toHaveLength(1);

    // Locked = read-only for everyone, still readable.
    const lockedId = nth(ids, 1);
    expect(
      (await server.request("GET", `/boards/${lockedId}`, { token: c.token })).body,
    ).toMatchObject({ locked: true });
    expect(
      (
        await server.request("PATCH", `/boards/${lockedId}`, {
          token: c.token,
          body: { title: "x" },
        })
      ).body,
    ).toMatchObject({
      error: { code: "BOARD_LOCKED" },
    });
    expect(
      (await server.request("POST", `/boards/${lockedId}/ticket`, { token: c.token, body: {} }))
        .body,
    ).toMatchObject({
      role: "viewer",
      limitedBy: "BOARD_LOCKED",
    });
    const [downgrade] = await db
      .select({ n: count() })
      .from(auditLogs)
      .where(
        dsql`${auditLogs.action} = 'billing.downgrade' and ${auditLogs.metadata}->>'userId' = ${c.user.id}`,
      );
    expect(downgrade?.n).toBe(1);

    // The payment finally goes through: Pro again, everything unlocked.
    fake.charge(c.providerId, clock.now());
    await sendWebhook(server, { type: "subscription.charged", subscriptionId: c.providerId });
    expect(await planOf(c.token)).toBe("pro");
    const unlocked = await db
      .select({ locked: boards.planLockedAt })
      .from(boards)
      .where(inArray(boards.id, ids));
    expect(unlocked.every((r) => r.locked === null)).toBe(true);
  });
});

describe("cancelling", () => {
  it("keeps Pro until the end of the paid period, then locks at period end", async () => {
    const c = await subscribed("Canceller");
    await createBoards(c.token, 4);
    const res = await server.request("POST", "/billing/cancel", {
      token: c.token,
      body: { subscriptionId: c.subscriptionId },
    });
    expect(res.status).toBe(200);
    expect(fake.calls.filter((call) => call.method === "cancel")).toHaveLength(1);
    // Idempotent.
    await server.request("POST", "/billing/cancel", {
      token: c.token,
      body: { subscriptionId: c.subscriptionId },
    });
    expect(fake.calls.filter((call) => call.method === "cancel")).toHaveLength(1);
    expect(await planOf(c.token)).toBe("pro");
    const summary = (await server.request("GET", "/billing", { token: c.token })).body as {
      subscriptions: { cancelAtPeriodEnd: boolean; nextChargeAt: string | null }[];
    };
    expect(summary.subscriptions[0]).toMatchObject({ cancelAtPeriodEnd: true, nextChargeAt: null });

    clock.advanceDays(31);
    expect(await planOf(c.token)).toBe("free");
    await sweep();
    const [lockedCount] = await db
      .select({ n: count() })
      .from(boards)
      .where(dsql`${boards.ownerId} = ${c.user.id} and ${boards.planLockedAt} is not null`);
    expect(lockedCount?.n).toBe(1);
    // The provider's own "cancelled" event later changes nothing about the outcome.
    fake.set(c.providerId, { status: "cancelled", endedAt: clock.now() });
    await sendWebhook(server, { type: "subscription.cancelled", subscriptionId: c.providerId });
    expect(await planOf(c.token)).toBe("free");
  });

  it("only lets the purchaser cancel", async () => {
    const c = await subscribed("Owner of sub");
    const other = await newUser("Stranger");
    const res = await server.request("POST", "/billing/cancel", {
      token: other.token,
      body: { subscriptionId: c.subscriptionId },
    });
    expect(res.status).toBe(403);
  });
});

describe("plan and seat changes", () => {
  it("upgrades seats mid-cycle immediately and schedules a cheaper change for the cycle end", async () => {
    const c = await subscribed("Team lead", "team_monthly", 2);
    expect(await planOf(c.token)).toBe("team");
    const up = await server.request("POST", "/billing/change-plan", {
      token: c.token,
      body: { subscriptionId: c.subscriptionId, planId: "team_monthly", seats: 5 },
    });
    expect(up.body).toEqual({ effective: "now" });
    expect((await subRow(c.subscriptionId)).quantity).toBe(5);
    const [grant] = await db
      .select()
      .from(entitlements)
      .where(dsql`${entitlements.userId} = ${c.user.id} and ${entitlements.source} = 'team_seat'`);
    expect(grant?.seats).toBe(5);

    const down = await server.request("POST", "/billing/change-plan", {
      token: c.token,
      body: { subscriptionId: c.subscriptionId, planId: "team_monthly", seats: 3 },
    });
    expect(down.body).toEqual({ effective: "cycle_end" });
    expect((await subRow(c.subscriptionId)).quantity).toBe(5);
    expect((await subRow(c.subscriptionId)).hasScheduledChange).toBe(true);
  });

  it("upgrades from Pro to Team mid-cycle (Team unlocks at once)", async () => {
    const c = await subscribed("Upgrader");
    expect(await planOf(c.token)).toBe("pro");
    const res = await checkout(c.token, { planId: "team_monthly", seats: 3 });
    expect(res.status).toBe(200);
    const providerId = (res.body as { razorpay: { subscriptionId: string } }).razorpay
      .subscriptionId;
    providerIds.push(providerId);
    fake.charge(providerId, clock.now(), 299700);
    await sendWebhook(server, { type: "subscription.activated", subscriptionId: providerId });
    expect(await planOf(c.token)).toBe("team");
  });

  it("gives Team to members up to the seat count and takes it away when seats drop", async () => {
    const c = await subscribed("Captain", "team_monthly", 3);
    const summary = (await server.request("GET", "/billing", { token: c.token })).body as {
      teams: { orgId: string }[];
    };
    const orgId = nth(summary.teams, 0).orgId;
    const a = await newUser("Mate A");
    const b = await newUser("Mate B");
    const extra = await newUser("Mate C");
    for (const m of [a, b])
      expect(
        (
          await server.request("POST", `/teams/${orgId}/members`, {
            token: c.token,
            body: { email: m.user.email },
          })
        ).status,
      ).toBe(201);
    expect(
      (
        await server.request("POST", `/teams/${orgId}/members`, {
          token: c.token,
          body: { email: extra.user.email },
        })
      ).status,
    ).toBe(409);
    expect(await planOf(a.token)).toBe("team");
    expect(await planOf(b.token)).toBe("team");

    // Seats reduced at the provider (e.g. a scheduled change applied): B joined last, B loses.
    fake.set(c.providerId, { quantity: 2 });
    await sendWebhook(server, { type: "subscription.updated", subscriptionId: c.providerId });
    expect(await planOf(a.token)).toBe("team");
    expect(await planOf(b.token)).toBe("free");
    await sweep();
    expect(
      server.mailer.sent.some((m) => m.to === b.user.email && m.subject.includes("Free plan")),
    ).toBe(true);
  });

  it("pools the team's AI reviews across its seats", async () => {
    const c = await subscribed("Pool", "team_monthly", 2);
    const quota = (await server.request("GET", "/me/ai-quota", { token: c.token })).body as {
      reviewsLimit: number;
    };
    expect(quota.reviewsLimit).toBe(600);
  });
});

describe("coupons", () => {
  it("validates codes, passes the offer to the provider and counts a redemption once", async () => {
    const code = `T${String(Date.now()).slice(-8)}`;
    await sql`insert into coupons (code, provider, provider_offer_id, description, max_redemptions, plan_ids)
              values (${code}, 'razorpay', 'offer_test', '20% off', 5, ${["pro_monthly"]})`;
    try {
      const { token } = await newUser("Couponer");
      expect((await checkout(token, { planId: "pro_monthly", couponCode: "NOPE123" })).status).toBe(
        400,
      );
      expect((await checkout(token, { planId: "pro_yearly", couponCode: code })).status).toBe(400);
      const preview = await server.request(
        "GET",
        `/billing/coupon?code=${code.toLowerCase()}&planId=pro_monthly`,
        { token },
      );
      expect(preview.body).toEqual({ code, description: "20% off" });
      const res = await checkout(token, { planId: "pro_monthly", couponCode: code });
      expect(res.status).toBe(200);
      const providerId = (res.body as { razorpay: { subscriptionId: string } }).razorpay
        .subscriptionId;
      providerIds.push(providerId);
      expect(fake.calls.at(-1)).toMatchObject({
        method: "createCheckout",
        args: { offerId: "offer_test" },
      });
      fake.charge(providerId, clock.now());
      for (let i = 0; i < 3; i++)
        await sendWebhook(server, { type: "subscription.charged", subscriptionId: providerId });
      const [row] = await sql<
        { redemptions: number }[]
      >`select redemptions from coupons where code = ${code}`;
      expect(row?.redemptions).toBe(1);
    } finally {
      await sql`delete from coupons where code = ${code}`;
    }
  });
});
