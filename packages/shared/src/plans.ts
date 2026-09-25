/**
 * Plans and what each one includes (SPEC.md → Plans). Enforced on the server from the
 * `entitlements` table; the web app only uses this to explain limits. Billing (Phase 10)
 * changes a user's plan, never these numbers.
 */
export const PLANS = ["free", "pro", "team"] as const;
export type Plan = (typeof PLANS)[number];

export interface PlanLimits {
  /** AI design reviews per calendar month (UTC). */
  aiReviewsPerMonth: number;
  /** Live AI hints while drawing. */
  liveHints: boolean;
  /** Interview mode: roles, question bank, timer, private notes, scorecard, replay. */
  interviewMode: boolean;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: { aiReviewsPerMonth: 5, liveHints: false, interviewMode: false },
  pro: { aiReviewsPerMonth: 100, liveHints: true, interviewMode: false },
  // Per seat; pooling across an organization's seats arrives with team billing (Phase 10).
  team: { aiReviewsPerMonth: 300, liveHints: true, interviewMode: true },
};

export const PLAN_NAMES: Record<Plan, string> = { free: "Free", pro: "Pro", team: "Team" };
