import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { createSafeFetch } from "../http/safeFetch";
import type { SubscriptionStatus } from "@whiteboard/shared/entitlements";
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
} from "./provider";

/**
 * Razorpay Subscriptions over its REST API (plain fetch + zod: six endpoints don't justify an
 * SDK, and every response is validated before we trust it). Test mode and live mode differ
 * only by keys and plan ids.
 */
export interface RazorpayOptions {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  /** Injected in tests. */
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

const unix = z
  .number()
  .int()
  .nullable()
  .optional()
  .transform((value) => (value === null || value === undefined ? null : new Date(value * 1000)));

const RAZORPAY_STATUSES = [
  "created",
  "authenticated",
  "active",
  "pending",
  "halted",
  "cancelled",
  "completed",
  "expired",
  "paused",
] as const;

/** Razorpay's names → ours. "pending" = a renewal failed and is being retried. */
const STATUS_MAP: Record<(typeof RAZORPAY_STATUSES)[number], SubscriptionStatus> = {
  created: "created",
  authenticated: "authenticated",
  active: "active",
  pending: "past_due",
  halted: "halted",
  cancelled: "cancelled",
  completed: "completed",
  expired: "expired",
  paused: "paused",
};

const notesSchema = z
  .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
  .nullable()
  .optional()
  .transform((notes) => {
    const out: Record<string, string> = {};
    if (notes && !Array.isArray(notes)) {
      for (const [key, value] of Object.entries(notes))
        if (typeof value === "string") out[key] = value;
    }
    return out;
  });

export const razorpaySubscriptionSchema = z.object({
  id: z.string().startsWith("sub_"),
  plan_id: z.string(),
  customer_id: z.string().nullable().optional(),
  status: z.enum(RAZORPAY_STATUSES),
  quantity: z.number().int().positive().nullable().optional(),
  current_start: unix,
  current_end: unix,
  ended_at: unix,
  charge_at: unix,
  has_scheduled_changes: z.boolean().nullable().optional(),
  offer_id: z.string().nullable().optional(),
  short_url: z.string().nullable().optional(),
  notes: notesSchema,
});

const RAZORPAY_INVOICE_STATUSES = [
  "draft",
  "issued",
  "partially_paid",
  "paid",
  "cancelled",
  "expired",
  "deleted",
] as const;

export const razorpayInvoiceSchema = z.object({
  id: z.string(),
  status: z.enum(RAZORPAY_INVOICE_STATUSES),
  amount: z.number().int(),
  currency: z.string(),
  payment_id: z.string().nullable().optional(),
  billing_start: unix,
  billing_end: unix,
  issued_at: unix,
  paid_at: unix,
  short_url: z.string().nullable().optional(),
});

const invoiceListSchema = z.object({ items: z.array(razorpayInvoiceSchema) });

const webhookBodySchema = z.object({
  event: z.string().min(1).max(100),
  payload: z
    .object({
      subscription: z.object({ entity: z.object({ id: z.string() }) }).optional(),
    })
    .loose(),
});

const errorSchema = z.object({ error: z.object({ description: z.string().optional() }) });

export class RazorpayProvider implements BillingProvider {
  readonly name = "razorpay" as const;
  readonly publicKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: RazorpayOptions) {
    this.publicKey = options.keyId;
    this.baseUrl = options.baseUrl ?? "https://api.razorpay.com/v1";
    // Only Razorpay's API, whatever ends up in a path (ids are also checked before use).
    this.fetchImpl = createSafeFetch([this.baseUrl], options.fetch ?? fetch);
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async createCheckout(input: CheckoutInput): Promise<ProviderCheckout> {
    const raw = await this.call("POST", "/subscriptions", {
      plan_id: input.providerPlanId,
      total_count: input.totalCount,
      quantity: input.quantity,
      // Razorpay's own emails would duplicate ours (receipts, failures).
      customer_notify: false,
      ...(input.offerId ? { offer_id: input.offerId } : {}),
      notes: input.notes,
    });
    const subscription = toSubscription(parse(razorpaySubscriptionSchema, raw));
    return {
      subscription,
      client: { keyId: this.options.keyId, subscriptionId: subscription.id },
    };
  }

  async getSubscription(providerSubscriptionId: string): Promise<ProviderSubscription> {
    const raw = await this.call("GET", `/subscriptions/${encodeId(providerSubscriptionId)}`);
    return toSubscription(parse(razorpaySubscriptionSchema, raw));
  }

  async listInvoices(providerSubscriptionId: string): Promise<ProviderInvoice[]> {
    const raw = await this.call(
      "GET",
      `/invoices?subscription_id=${encodeId(providerSubscriptionId)}&count=100`,
    );
    return parse(invoiceListSchema, raw)
      .items.map(toInvoice)
      .filter((invoice): invoice is ProviderInvoice => invoice !== null);
  }

  async cancel(providerSubscriptionId: string): Promise<void> {
    await this.call("POST", `/subscriptions/${encodeId(providerSubscriptionId)}/cancel`, {
      cancel_at_cycle_end: true,
    });
  }

  async changePlan(providerSubscriptionId: string, change: PlanChange): Promise<void> {
    await this.call("PATCH", `/subscriptions/${encodeId(providerSubscriptionId)}`, {
      plan_id: change.providerPlanId,
      quantity: change.quantity,
      schedule_change_at: change.when,
      customer_notify: false,
    });
  }

  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent {
    const signature = header(headers, "x-razorpay-signature");
    const eventId = header(headers, "x-razorpay-event-id");
    if (!signature || !verifyHmac(rawBody, signature, this.options.webhookSecret))
      throw new WebhookSignatureError();
    // Only a verified body is parsed.
    if (!eventId || eventId.length > 100) throw new WebhookSignatureError("missing event id");
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new WebhookSignatureError("malformed webhook body");
    }
    const parsed = webhookBodySchema.safeParse(body);
    if (!parsed.success) throw new WebhookSignatureError("unexpected webhook body");
    return {
      id: eventId,
      type: parsed.data.event,
      subscriptionId: parsed.data.payload.subscription?.entity.id ?? null,
    };
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const auth = Buffer.from(`${this.options.keyId}:${this.options.keySecret}`).toString("base64");
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Basic ${auth}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ProviderError(`Razorpay ${method} ${stripQuery(path)} failed`, false, null, {
        cause: error,
      });
    }
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      const description = errorSchema.safeParse(json).data?.error.description ?? null;
      throw new ProviderError(
        `Razorpay ${method} ${stripQuery(path)} → ${String(response.status)}`,
        response.status >= 400 && response.status < 500 && response.status !== 429,
        description,
      );
    }
    return json;
  }
}

/** Verifies X-Razorpay-Signature: hex HMAC-SHA256 of the raw body with the webhook secret. */
export function verifyHmac(rawBody: Buffer, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  if (!/^[0-9a-f]+$/i.test(signature)) return false;
  const provided = Buffer.from(signature, "hex");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function signWebhook(rawBody: Buffer | string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function toSubscription(raw: z.output<typeof razorpaySubscriptionSchema>): ProviderSubscription {
  return {
    id: raw.id,
    customerId: raw.customer_id ?? null,
    providerPlanId: raw.plan_id,
    status: STATUS_MAP[raw.status],
    quantity: raw.quantity ?? 1,
    currentPeriodStart: raw.current_start,
    currentPeriodEnd: raw.current_end,
    nextChargeAt: raw.charge_at,
    endedAt: raw.ended_at,
    hasScheduledChange: raw.has_scheduled_changes ?? false,
    offerId: raw.offer_id ?? null,
    paymentUrl: raw.short_url ?? null,
    notes: raw.notes,
  };
}

function toInvoice(raw: z.output<typeof razorpayInvoiceSchema>): ProviderInvoice | null {
  const status = (() => {
    switch (raw.status) {
      case "paid":
        return "paid" as const;
      case "issued":
      case "partially_paid":
        return "issued" as const;
      case "expired":
        return "failed" as const;
      case "cancelled":
      case "deleted":
        return "cancelled" as const;
      case "draft":
        return null;
    }
  })();
  if (status === null) return null;
  return {
    id: raw.id,
    paymentId: raw.payment_id ?? null,
    status,
    amountMinor: raw.amount,
    currency: raw.currency,
    periodStart: raw.billing_start,
    periodEnd: raw.billing_end,
    issuedAt: raw.issued_at,
    paidAt: raw.paid_at,
    receiptUrl: raw.short_url ?? null,
  };
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  // An unexpected shape is an outage-like failure: retried, never half-applied.
  if (!result.success) throw new ProviderError("Unexpected response from Razorpay", false);
  return result.data;
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function encodeId(id: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(id)) throw new ProviderError("Invalid provider id", true);
  return id;
}

function stripQuery(path: string): string {
  return path.split("?")[0] ?? path;
}
