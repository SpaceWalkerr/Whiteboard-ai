import type { BillingProviderName } from "@whiteboard/shared/billing";
import type { SubscriptionStatus } from "@whiteboard/shared/entitlements";

/**
 * A payment provider behind one interface. Razorpay (India, INR) is the first; a Merchant of
 * Record (Paddle / Lemon Squeezy) for international customers can be added as a second
 * implementation without touching the webhook pipeline, entitlements or limits: everything
 * outside this folder works with these provider-neutral types.
 */
export interface BillingProvider {
  readonly name: BillingProviderName;
  /** Public key the browser's checkout script needs (never a secret). */
  readonly publicKey: string;
  /** Starts a subscription the customer then pays for in the provider's checkout. */
  createCheckout(input: CheckoutInput): Promise<ProviderCheckout>;
  /** The subscription as the provider sees it now (the only source of truth we apply). */
  getSubscription(providerSubscriptionId: string): Promise<ProviderSubscription>;
  /** Invoices of a subscription, newest first. */
  listInvoices(providerSubscriptionId: string): Promise<ProviderInvoice[]>;
  /** Cancels renewal; the plan stays until the end of the paid period. */
  cancel(providerSubscriptionId: string): Promise<void>;
  changePlan(providerSubscriptionId: string, change: PlanChange): Promise<void>;
  /**
   * Checks the signature over the exact raw body and returns the event's identity. Throws
   * WebhookSignatureError when it doesn't verify: nothing from an unverified body is used.
   */
  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent;
}

export interface CheckoutInput {
  providerPlanId: string;
  quantity: number;
  /** Billing cycles before the subscription completes on its own. */
  totalCount: number;
  offerId: string | null;
  /** Our ids, stored with the subscription at the provider (recovery if our row is missing). */
  notes: { orgId: string; userId: string; planId: string };
}

export interface ProviderCheckout {
  subscription: ProviderSubscription;
  /** What the browser needs to open the provider's checkout. */
  client: { keyId: string; subscriptionId: string };
}

export interface ProviderSubscription {
  id: string;
  customerId: string | null;
  providerPlanId: string;
  status: SubscriptionStatus;
  quantity: number;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  nextChargeAt: Date | null;
  endedAt: Date | null;
  hasScheduledChange: boolean;
  offerId: string | null;
  /** Hosted page where the customer can authorize a payment method again. */
  paymentUrl: string | null;
  notes: Record<string, string>;
}

export interface ProviderInvoice {
  id: string;
  paymentId: string | null;
  status: "paid" | "issued" | "failed" | "cancelled";
  amountMinor: number;
  currency: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  issuedAt: Date | null;
  paidAt: Date | null;
  receiptUrl: string | null;
}

export interface PlanChange {
  providerPlanId: string;
  quantity: number;
  when: "now" | "cycle_end";
}

export interface WebhookEvent {
  /** Unique per event; redeliveries carry the same id. */
  id: string;
  type: string;
  /** The subscription the event is about, if any. */
  subscriptionId: string | null;
}

export class WebhookSignatureError extends Error {
  constructor(message = "invalid webhook signature") {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

/**
 * The provider answered with an error or not at all. `refused` = it rejected the request
 * (4xx: e.g. a change it doesn't allow); otherwise it's an outage worth retrying.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly refused: boolean,
    /** The provider's own description, if it gave one (shown to the user for refusals). */
    readonly providerMessage: string | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderError";
  }
}
