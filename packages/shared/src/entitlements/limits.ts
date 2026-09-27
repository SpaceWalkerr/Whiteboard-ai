/**
 * Plans and what each one includes (SPEC.md → Plans). The single definition used by the REST
 * API, the sync server and the web app. Billing changes which plan a user has, never these
 * numbers.
 */
export const PLANS = ["free", "pro", "team"] as const;
export type Plan = (typeof PLANS)[number];

export interface PlanLimits {
  /** Boards a user may own (trash excluded); null = unlimited. */
  boards: number | null;
  /** People who may edit one board at all, the owner included. */
  editorsPerBoard: number;
  /** AI design reviews per calendar month (UTC); per seat and pooled across a team. */
  aiReviewsPerMonth: number;
  /** Live AI hints while drawing. */
  liveHints: boolean;
  /** Interview mode: roles, question bank, timer, private notes, scorecard, replay. */
  interviewMode: boolean;
  /** Private boards: end-to-end encrypted, the server can't read them. */
  privateRooms: boolean;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: {
    boards: 3,
    editorsPerBoard: 3,
    aiReviewsPerMonth: 5,
    liveHints: false,
    interviewMode: false,
    privateRooms: false,
  },
  pro: {
    boards: null,
    editorsPerBoard: 10,
    aiReviewsPerMonth: 100,
    liveHints: true,
    interviewMode: false,
    privateRooms: true,
  },
  team: {
    boards: null,
    editorsPerBoard: 50,
    aiReviewsPerMonth: 300,
    liveHints: true,
    interviewMode: true,
    privateRooms: true,
  },
};

export const PLAN_NAMES: Record<Plan, string> = { free: "Free", pro: "Pro", team: "Team" };

/** Higher is more. Used to pick the best of several grants. */
export const PLAN_RANK: Record<Plan, number> = { free: 0, pro: 1, team: 2 };

/** Days a subscription keeps its plan after a failed payment before dropping to Free. */
export const GRACE_PERIOD_DAYS = 7;
/** The grace-period reminder is sent this many days before the downgrade. */
export const GRACE_REMINDER_DAYS_BEFORE = 2;
/** Length of the student offer (Pro, free). */
export const STUDENT_TRIAL_MONTHS = 3;
