import { z } from "zod";
import { LIMIT_CODES } from "../entitlements/checks";
import { SUBSCRIPTION_STATUSES } from "../entitlements/derive";
import { PLANS } from "../entitlements/limits";

/**
 * Billing API contract (apps/web ↔ apps/server). Prices live in the `plans` table (the
 * catalog); provider-side plan ids are per-environment configuration on the server.
 */

export const BILLING_INTERVALS = ["month", "year"] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

/** Catalog ids (rows of the `plans` table). */
export const PLAN_IDS = ["pro_monthly", "pro_yearly", "team_monthly", "team_yearly"] as const;
export type PlanId = (typeof PLAN_IDS)[number];
export const planIdSchema = z.enum(PLAN_IDS);

export const BILLING_PROVIDERS = ["razorpay"] as const;
export type BillingProviderName = (typeof BILLING_PROVIDERS)[number];

/** Team subscriptions: seats (members, the owner included). */
export const MIN_TEAM_SEATS = 2;
export const MAX_TEAM_SEATS = 500;

export const catalogPlanSchema = z.object({
  id: planIdSchema,
  tier: z.enum(PLANS),
  interval: z.enum(BILLING_INTERVALS),
  currency: z.string(),
  /** In the currency's minor unit (paise); per seat for Team. */
  amountMinor: z.number().int().nonnegative(),
  perSeat: z.boolean(),
});
export type CatalogPlan = z.infer<typeof catalogPlanSchema>;
export const catalogResponseSchema = z.object({
  plans: z.array(catalogPlanSchema),
  /** False when the server has no payment provider configured (checkout unavailable). */
  checkoutAvailable: z.boolean(),
});
export type CatalogResponse = z.infer<typeof catalogResponseSchema>;

export const couponCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9_-]{3,32}$/, "Coupon codes are 3–32 letters, digits, - or _.");

export const checkoutRequestSchema = z.object({
  planId: planIdSchema,
  /** Team only. */
  seats: z.number().int().min(MIN_TEAM_SEATS).max(MAX_TEAM_SEATS).optional(),
  /** Team only: name of the new team workspace (defaults to "<name>'s team"). */
  teamName: z.string().trim().min(1).max(80).optional(),
  couponCode: couponCodeSchema.optional(),
});
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;

/** What the browser needs to open the provider's checkout. */
export const checkoutResponseSchema = z.object({
  provider: z.enum(BILLING_PROVIDERS),
  subscriptionId: z.uuid(),
  razorpay: z.object({ keyId: z.string(), subscriptionId: z.string() }),
  prefill: z.object({ email: z.string().nullable(), name: z.string().nullable() }),
  description: z.string(),
});
export type CheckoutResponse = z.infer<typeof checkoutResponseSchema>;

export const couponPreviewSchema = z.object({
  code: z.string(),
  description: z.string(),
});
export type CouponPreview = z.infer<typeof couponPreviewSchema>;

export const changePlanRequestSchema = z.object({
  subscriptionId: z.uuid(),
  planId: planIdSchema,
  seats: z.number().int().min(1).max(MAX_TEAM_SEATS).optional(),
});
export type ChangePlanRequest = z.infer<typeof changePlanRequestSchema>;
export const changePlanResponseSchema = z.object({
  /** "now": applied immediately; "cycle_end": at the end of the paid period. */
  effective: z.enum(["now", "cycle_end"]),
});

export const subscriptionIdRequestSchema = z.object({ subscriptionId: z.uuid() });

export const subscriptionSummarySchema = z.object({
  id: z.uuid(),
  orgId: z.uuid().nullable(),
  orgName: z.string().nullable(),
  planId: planIdSchema,
  tier: z.enum(PLANS),
  status: z.enum(SUBSCRIPTION_STATUSES),
  seats: z.number().int(),
  currentPeriodEnd: z.string().nullable(),
  /** Next charge (null when cancelled, ended or in a failed-payment state). */
  nextChargeAt: z.string().nullable(),
  nextChargeMinor: z.number().int().nullable(),
  currency: z.string(),
  cancelAtPeriodEnd: z.boolean(),
  graceUntil: z.string().nullable(),
  /** Whether the caller may cancel or change it (the purchaser / team owner). */
  canManage: z.boolean(),
  /** A plan or seat change the provider will apply at the end of the cycle. */
  scheduledChange: z.boolean(),
});
export type SubscriptionSummary = z.infer<typeof subscriptionSummarySchema>;

export const invoiceSummarySchema = z.object({
  id: z.uuid(),
  status: z.enum(["paid", "issued", "failed", "cancelled"]),
  amountMinor: z.number().int(),
  currency: z.string(),
  issuedAt: z.string().nullable(),
  paidAt: z.string().nullable(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  /** The provider's hosted invoice/receipt page. */
  receiptUrl: z.string().nullable(),
});
export type InvoiceSummary = z.infer<typeof invoiceSummarySchema>;

export const billingSummarySchema = z.object({
  plan: z.enum(PLANS),
  source: z.enum(["free", "subscription", "team_seat", "student_trial", "manual"]),
  /** When the current plan stops unless renewed (null = renews / Free). */
  validUntil: z.string().nullable(),
  subscriptions: z.array(subscriptionSummarySchema),
  invoices: z.array(invoiceSummarySchema),
  usage: z.object({
    boards: z.number().int(),
    boardLimit: z.number().int().nullable(),
    lockedBoards: z.number().int(),
    aiReviewsUsed: z.number().int(),
    aiReviewsLimit: z.number().int(),
    editorsPerBoard: z.number().int(),
  }),
  studentTrial: z.object({
    /** The signed-in email qualifies and no trial was used yet. */
    eligible: z.boolean(),
    activeUntil: z.string().nullable(),
  }),
  teams: z.array(
    z.object({ orgId: z.uuid(), name: z.string(), role: z.enum(["owner", "admin", "member"]) }),
  ),
  checkoutAvailable: z.boolean(),
});
export type BillingSummary = z.infer<typeof billingSummarySchema>;

export const studentTrialResponseSchema = z.object({ activeUntil: z.string() });

export const teamMemberSchema = z.object({
  userId: z.uuid(),
  email: z.string().nullable(),
  displayName: z.string(),
  role: z.enum(["owner", "admin", "member"]),
  /** Holds one of the subscription's seats (Team features). */
  hasSeat: z.boolean(),
});
export const teamResponseSchema = z.object({
  orgId: z.uuid(),
  name: z.string(),
  seats: z.number().int(),
  members: z.array(teamMemberSchema),
  canManage: z.boolean(),
});
export type TeamResponse = z.infer<typeof teamResponseSchema>;
export const addTeamMemberSchema = z.object({ email: z.email().trim().toLowerCase() });

/** Why the caller is read-only on a board although their role would allow editing. */
export const boardLimitReasonSchema = z.enum(["EDITOR_LIMIT", "BOARD_LOCKED"]);
export type BoardLimitReason = z.infer<typeof boardLimitReasonSchema>;

export const limitCodeSchema = z.enum(LIMIT_CODES);

export const editorSeatSchema = z.object({
  userId: z.uuid(),
  displayName: z.string(),
  email: z.string().nullable(),
  active: z.boolean(),
  claimedAt: z.string(),
});
export const editorSeatsResponseSchema = z.object({
  /** Seats for people other than the owner under the owner's plan. */
  limit: z.number().int(),
  seats: z.array(editorSeatSchema),
});
export type EditorSeatsResponse = z.infer<typeof editorSeatsResponseSchema>;

/** Formats a minor-unit amount for display (₹399, ₹3,990). */
export function formatMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    maximumFractionDigits: amountMinor % 100 === 0 ? 0 : 2,
  }).format(amountMinor / 100);
}
