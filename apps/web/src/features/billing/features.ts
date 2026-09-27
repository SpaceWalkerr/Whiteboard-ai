import { PLAN_LIMITS, type Plan } from "@whiteboard/shared/entitlements";

/** One row of the comparison: what a plan includes, from the single limits table. */
export const FEATURE_ROWS: { label: string; value: (plan: Plan) => string | boolean }[] = [
  {
    label: "Boards",
    value: (plan) =>
      PLAN_LIMITS[plan].boards === null ? "Unlimited" : String(PLAN_LIMITS[plan].boards),
  },
  { label: "Editors per board", value: (plan) => String(PLAN_LIMITS[plan].editorsPerBoard) },
  {
    label: "AI design reviews / month",
    value: (plan) =>
      plan === "team"
        ? `${String(PLAN_LIMITS[plan].aiReviewsPerMonth)} per seat, pooled`
        : String(PLAN_LIMITS[plan].aiReviewsPerMonth),
  },
  { label: "Live AI hints", value: (plan) => PLAN_LIMITS[plan].liveHints },
  { label: "End-to-end encrypted private boards", value: (plan) => PLAN_LIMITS[plan].privateRooms },
  { label: "Interview mode, scorecards, replay", value: (plan) => PLAN_LIMITS[plan].interviewMode },
];
