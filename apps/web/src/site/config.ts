/**
 * Business details shown on the public site (contact page, legal pages, footer, structured
 * data). Razorpay reviews these pages before activating payments, so they must be real.
 *
 * Values in [SQUARE BRACKETS] are placeholders: a production build (VERCEL_ENV=production)
 * refuses to prerender while any remain (see scripts/prerender.ts → unfilledPlaceholders).
 */
export const COMPANY = {
  productName: "Whiteboard.ai",
  /** Registered business name, or the proprietor's full name for a sole proprietorship. */
  legalName: "[LEGAL BUSINESS NAME]",
  /** Registered postal address (Razorpay checks it matches the KYC documents). */
  address: "[REGISTERED ADDRESS, CITY, STATE, PIN CODE, INDIA]",
  supportEmail: "[SUPPORT EMAIL]",
  phone: "[SUPPORT PHONE NUMBER]",
  /** Grievance Officer (Information Technology Rules, 2021 and the DPDP Act, 2023). */
  grievanceOfficerName: "[GRIEVANCE OFFICER NAME]",
  grievanceOfficerEmail: "[GRIEVANCE OFFICER EMAIL]",
  /** Courts with jurisdiction over disputes under the Terms. */
  jurisdictionCity: "[CITY]",
  supportHours: "Monday to Friday, 10:00–18:00 IST",
  responseTime: "within 2 business days",
} as const;

/**
 * The legal pages are drafts until a professional has reviewed them. While false, every legal
 * page shows a visible "draft" notice. Set to true only after that review. (Typed as boolean,
 * not the literal `false`, so the draft-notice check isn't flagged as a constant condition.)
 */
export const LEGAL_REVIEWED = false as boolean;

/** Shown as "Last updated" on the legal pages; change it whenever their text changes. */
export const LEGAL_UPDATED = "2026-09-27";

/** Refund window for a first payment on a plan (Refund & Cancellation Policy). */
export const REFUND_WINDOW_DAYS = 7;
/** How long an approved refund takes to reach the original payment method. */
export const REFUND_PROCESSING = "5–7 business days";

/**
 * The 60-second product demo on the landing page. Put the files in apps/web/public/ and set the
 * paths; until then the landing page shows a static diagram in its place. `captions` is a WebVTT
 * file (required: the demo must be understandable without sound).
 */
export const DEMO_VIDEO: { mp4: string; webm?: string; poster: string; captions: string } | null =
  null;

/**
 * Customer quotes for the landing page. Only real quotes, with the person's permission; the
 * section is hidden while the list is empty.
 */
export const TESTIMONIALS: readonly { quote: string; name: string; role: string }[] = [];

const PLACEHOLDER = /\[[A-Z0-9 ,]+\]/;

/** Names of the COMPANY fields that still hold a placeholder. */
export function unfilledPlaceholders(company: Record<string, string> = COMPANY): string[] {
  return Object.entries(company)
    .filter(([, value]) => PLACEHOLDER.test(value))
    .map(([key]) => key);
}
