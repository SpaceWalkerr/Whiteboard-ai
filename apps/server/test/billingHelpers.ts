import type { PlanId } from "@whiteboard/shared/billing";
import type { SubscriptionStatus } from "@whiteboard/shared/entitlements";
import type { BillingConfig } from "../src/billing/context";
import {
  ProviderError,
  WebhookSignatureError,
  type BillingProvider,
  type CheckoutInput,
  type PlanChange,
  type ProviderCheckout,
  type ProviderInvoice,
  type ProviderSubscription,
  type WebhookEvent,
} from "../src/billing/provider";
import { signWebhook, verifyHmac } from "../src/billing/razorpay";
import type { ApiServer } from "./authHelpers";

export const WEBHOOK_SECRET = "test-webhook-secret-0123456789";

export const PROVIDER_PLAN_IDS: Record<PlanId, string> = {
  pro_monthly: "plan_pro_m",
  pro_yearly: "plan_pro_y",
  team_monthly: "plan_team_m",
  team_yearly: "plan_team_y",
};

const DAY = 24 * 60 * 60 * 1000;

/**
 * An in-memory payment provider: tests script the "current state at the provider", which is
 * all the webhook pipeline ever reads. Webhooks are signed exactly like Razorpay's.
 */
export class FakeBillingProvider implements BillingProvider {
  readonly name = "razorpay" as const;
  readonly publicKey = "rzp_test_fake";
  readonly subs = new Map<string, ProviderSubscription>();
  readonly invoices = new Map<string, ProviderInvoice[]>();
  readonly calls: { method: string; args: unknown }[] = [];
  /** Makes the next N getSubscription calls fail like an outage. */
  failFetches = 0;
  private counter = 0;

  createCheckout(input: CheckoutInput): Promise<ProviderCheckout> {
    this.calls.push({ method: "createCheckout", args: input });
    this.counter += 1;
    const sub: ProviderSubscription = {
      id: `sub_fake${String(Date.now())}${String(this.counter)}`,
      customerId: null,
      providerPlanId: input.providerPlanId,
      status: "created",
      quantity: input.quantity,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      nextChargeAt: null,
      endedAt: null,
      hasScheduledChange: false,
      offerId: input.offerId,
      paymentUrl: "https://rzp.example/pay",
      notes: { ...input.notes },
    };
    this.subs.set(sub.id, sub);
    return Promise.resolve({
      subscription: { ...sub },
      client: { keyId: this.publicKey, subscriptionId: sub.id },
    });
  }

  getSubscription(id: string): Promise<ProviderSubscription> {
    this.calls.push({ method: "getSubscription", args: id });
    if (this.failFetches > 0) {
      this.failFetches -= 1;
      return Promise.reject(new ProviderError("fake outage", false));
    }
    const sub = this.subs.get(id);
    if (!sub) return Promise.reject(new ProviderError("not found", true));
    return Promise.resolve({ ...sub, notes: { ...sub.notes } });
  }

  listInvoices(id: string): Promise<ProviderInvoice[]> {
    return Promise.resolve([...(this.invoices.get(id) ?? [])]);
  }

  cancel(id: string): Promise<void> {
    this.calls.push({ method: "cancel", args: id });
    return Promise.resolve();
  }

  changePlan(id: string, change: PlanChange): Promise<void> {
    this.calls.push({ method: "changePlan", args: { id, ...change } });
    const sub = this.subs.get(id);
    if (!sub) return Promise.reject(new ProviderError("not found", true));
    if (change.when === "now")
      this.set(id, { providerPlanId: change.providerPlanId, quantity: change.quantity });
    else this.set(id, { hasScheduledChange: true });
    return Promise.resolve();
  }

  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent {
    const signature = headers["x-razorpay-signature"];
    const eventId = headers["x-razorpay-event-id"];
    if (typeof signature !== "string" || !verifyHmac(rawBody, signature, WEBHOOK_SECRET))
      throw new WebhookSignatureError();
    if (typeof eventId !== "string") throw new WebhookSignatureError("missing event id");
    const body = JSON.parse(rawBody.toString("utf8")) as {
      event: string;
      payload: { subscription?: { entity: { id: string } } };
    };
    return {
      id: eventId,
      type: body.event,
      subscriptionId: body.payload.subscription?.entity.id ?? null,
    };
  }

  // ── scripting helpers ──

  set(id: string, patch: Partial<ProviderSubscription>): void {
    const sub = this.subs.get(id);
    if (!sub) throw new Error(`no fake subscription ${id}`);
    this.subs.set(id, { ...sub, ...patch });
  }

  status(id: string, status: SubscriptionStatus): void {
    this.set(id, { status });
  }

  /** A successful charge: active, a new period, a paid invoice. */
  charge(id: string, periodStart: Date, amountMinor = 39900): ProviderInvoice {
    const periodEnd = new Date(periodStart.getTime() + 30 * DAY);
    this.set(id, {
      status: "active",
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      nextChargeAt: periodEnd,
    });
    const invoice: ProviderInvoice = {
      id: `inv_${id}_${String(periodStart.getTime())}`,
      paymentId: `pay_${String(periodStart.getTime())}`,
      status: "paid",
      amountMinor,
      currency: "INR",
      periodStart,
      periodEnd,
      issuedAt: periodStart,
      paidAt: periodStart,
      receiptUrl: "https://rzp.example/invoice",
    };
    this.invoices.set(id, [invoice, ...(this.invoices.get(id) ?? [])]);
    return invoice;
  }
}

export function fakeBilling(): { provider: FakeBillingProvider; config: BillingConfig } {
  const provider = new FakeBillingProvider();
  return { provider, config: { provider, providerPlanIds: PROVIDER_PLAN_IDS } };
}

/** A mutable clock for grace periods and period ends. */
export class TestClock {
  constructor(private time = Date.now()) {}
  now = (): Date => new Date(this.time);
  advanceDays(days: number): void {
    this.time += days * DAY;
  }
  at(days: number): Date {
    return new Date(this.time + days * DAY);
  }
}

let eventCounter = 0;
export function newEventId(): string {
  eventCounter += 1;
  return `evt_test_${String(Date.now())}_${String(eventCounter)}`;
}

/** Delivers a Razorpay-shaped, correctly signed webhook (or a tampered one). */
export async function sendWebhook(
  server: ApiServer,
  event: { id?: string; type: string; subscriptionId: string | null },
  options: { secret?: string; tamper?: boolean; omitEventId?: boolean } = {},
): Promise<{ status: number; body: unknown }> {
  const body = JSON.stringify({
    entity: "event",
    account_id: "acc_test",
    event: event.type,
    contains: ["subscription"],
    payload: event.subscriptionId
      ? { subscription: { entity: { id: event.subscriptionId, status: "active" } } }
      : {},
    created_at: Math.floor(Date.now() / 1000),
  });
  const signature = signWebhook(body, options.secret ?? WEBHOOK_SECRET);
  const sent = options.tamper ? body.replace('"active"', '"halted"') : body;
  return server.request("POST", "/billing/webhooks/razorpay", {
    rawBody: new TextEncoder().encode(sent),
    headers: {
      "content-type": "application/json",
      "x-razorpay-signature": signature,
      ...(options.omitEventId ? {} : { "x-razorpay-event-id": event.id ?? newEventId() }),
    },
  });
}

/** The i-th element, failing the test (not the type checker) when it's missing. */
export function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`expected an element at index ${String(index)}`);
  return item;
}
