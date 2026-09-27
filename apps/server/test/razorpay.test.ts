import { describe, expect, it } from "vitest";
import { ProviderError, WebhookSignatureError } from "../src/billing/provider";
import { RazorpayProvider, signWebhook, verifyHmac } from "../src/billing/razorpay";

const SECRET = "whsec_0123456789";

interface Recorded {
  url: string;
  method: string;
  body: unknown;
  auth: string | null;
}

function provider(responses: { status: number; body: unknown }[]) {
  const calls: Recorded[] = [];
  const fetchImpl = (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      auth: headers.get("authorization"),
    });
    const next = responses.shift() ?? { status: 500, body: {} };
    return Promise.resolve(new Response(JSON.stringify(next.body), { status: next.status }));
  };
  return {
    calls,
    rzp: new RazorpayProvider({
      keyId: "rzp_test_abc",
      keySecret: "secret123456",
      webhookSecret: SECRET,
      fetch: fetchImpl,
    }),
  };
}

const subscription = (overrides: Record<string, unknown> = {}) => ({
  id: "sub_ABC123",
  entity: "subscription",
  plan_id: "plan_pro_m",
  customer_id: "cust_1",
  status: "active",
  current_start: 1_790_000_000,
  current_end: 1_792_592_000,
  ended_at: null,
  quantity: 1,
  notes: { orgId: "o", userId: "u", planId: "pro_monthly", ignored: 5 },
  charge_at: 1_792_592_000,
  offer_id: null,
  short_url: "https://rzp.io/i/x",
  has_scheduled_changes: false,
  ...overrides,
});

describe("webhook signatures", () => {
  const body = Buffer.from(
    JSON.stringify({
      event: "subscription.charged",
      payload: { subscription: { entity: { id: "sub_ABC123" } } },
    }),
  );
  const headers = (signature: string) => ({
    "x-razorpay-signature": signature,
    "x-razorpay-event-id": "evt_1",
  });

  it("accepts the exact body signed with the webhook secret", () => {
    const { rzp } = provider([]);
    expect(rzp.verifyWebhook(body, headers(signWebhook(body, SECRET)))).toEqual({
      id: "evt_1",
      type: "subscription.charged",
      subscriptionId: "sub_ABC123",
    });
  });

  it("rejects a tampered body, a wrong secret, a missing signature or event id", () => {
    const { rzp } = provider([]);
    const tampered = Buffer.from(body.toString().replace("charged", "cancelled"));
    expect(() => rzp.verifyWebhook(tampered, headers(signWebhook(body, SECRET)))).toThrow(
      WebhookSignatureError,
    );
    expect(() => rzp.verifyWebhook(body, headers(signWebhook(body, "other-secret")))).toThrow(
      WebhookSignatureError,
    );
    expect(() => rzp.verifyWebhook(body, {})).toThrow(WebhookSignatureError);
    expect(() =>
      rzp.verifyWebhook(body, { "x-razorpay-signature": signWebhook(body, SECRET) }),
    ).toThrow("missing event id");
    expect(() => rzp.verifyWebhook(body, headers("not-hex!"))).toThrow(WebhookSignatureError);
  });

  it("compares in constant time and refuses signatures of the wrong length", () => {
    const signature = signWebhook(body, SECRET);
    expect(verifyHmac(body, signature, SECRET)).toBe(true);
    expect(verifyHmac(body, signature.slice(0, -2), SECRET)).toBe(false);
  });
});

describe("REST calls", () => {
  it("creates a subscription with our notes and basic auth, without Razorpay's own emails", async () => {
    const { rzp, calls } = provider([{ status: 200, body: subscription({ status: "created" }) }]);
    const checkout = await rzp.createCheckout({
      providerPlanId: "plan_pro_m",
      quantity: 1,
      totalCount: 120,
      offerId: "offer_1",
      notes: { orgId: "o", userId: "u", planId: "pro_monthly" },
    });
    expect(checkout.client).toEqual({ keyId: "rzp_test_abc", subscriptionId: "sub_ABC123" });
    expect(calls[0]).toMatchObject({
      url: "https://api.razorpay.com/v1/subscriptions",
      method: "POST",
      body: {
        plan_id: "plan_pro_m",
        total_count: 120,
        quantity: 1,
        customer_notify: false,
        offer_id: "offer_1",
        notes: { orgId: "o", userId: "u", planId: "pro_monthly" },
      },
      auth: `Basic ${Buffer.from("rzp_test_abc:secret123456").toString("base64")}`,
    });
  });

  it("maps Razorpay's subscription to provider-neutral fields", async () => {
    const { rzp } = provider([{ status: 200, body: subscription({ status: "pending" }) }]);
    const sub = await rzp.getSubscription("sub_ABC123");
    expect(sub).toMatchObject({
      status: "past_due",
      currentPeriodEnd: new Date(1_792_592_000 * 1000),
      paymentUrl: "https://rzp.io/i/x",
      notes: { orgId: "o", userId: "u", planId: "pro_monthly" },
    });
  });

  it("maps invoices and skips drafts", async () => {
    const { rzp } = provider([
      {
        status: 200,
        body: {
          items: [
            {
              id: "inv_1",
              status: "paid",
              amount: 39900,
              currency: "INR",
              paid_at: 1_790_000_000,
              short_url: "u",
            },
            { id: "inv_2", status: "draft", amount: 39900, currency: "INR" },
            { id: "inv_3", status: "expired", amount: 39900, currency: "INR" },
          ],
        },
      },
    ]);
    const invoices = await rzp.listInvoices("sub_ABC123");
    expect(invoices.map((i) => [i.id, i.status])).toEqual([
      ["inv_1", "paid"],
      ["inv_3", "failed"],
    ]);
  });

  it("cancels at the end of the cycle and changes plans with a schedule", async () => {
    const { rzp, calls } = provider([
      { status: 200, body: subscription() },
      { status: 200, body: subscription() },
    ]);
    await rzp.cancel("sub_ABC123");
    await rzp.changePlan("sub_ABC123", { providerPlanId: "plan_team_m", quantity: 4, when: "now" });
    expect(calls[0]).toMatchObject({
      url: "https://api.razorpay.com/v1/subscriptions/sub_ABC123/cancel",
      body: { cancel_at_cycle_end: true },
    });
    expect(calls[1]).toMatchObject({
      method: "PATCH",
      body: { plan_id: "plan_team_m", quantity: 4, schedule_change_at: "now" },
    });
  });

  it("reports refusals (4xx, with Razorpay's reason) apart from outages", async () => {
    const { rzp } = provider([
      { status: 400, body: { error: { description: "UPI subscriptions can't be updated" } } },
      { status: 503, body: {} },
      { status: 200, body: { unexpected: true } },
    ]);
    const refused = await rzp
      .changePlan("sub_ABC123", { providerPlanId: "p", quantity: 1, when: "now" })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ProviderError);
    expect(refused).toMatchObject({
      refused: true,
      providerMessage: "UPI subscriptions can't be updated",
    });
    await expect(rzp.getSubscription("sub_ABC123")).rejects.toMatchObject({ refused: false });
    await expect(rzp.getSubscription("sub_ABC123")).rejects.toThrow("Unexpected response");
  });

  it("never puts an unsafe id into a URL", async () => {
    const { rzp, calls } = provider([]);
    await expect(rzp.getSubscription("../payments")).rejects.toThrow(ProviderError);
    expect(calls).toHaveLength(0);
  });
});
