import { z } from "zod";

/**
 * Interview mode (Team plan) contract between apps/web and apps/server.
 *
 * Privacy model: anything a candidate may see travels in `PublicInterviewState` (sent to every
 * socket in the room). Everything private — interviewer notes, hints that were not revealed,
 * scorecards, reviews run during the interview — is only ever returned by REST routes that
 * check the caller's interview role. The public state type has no private fields, so nothing
 * private can be sent to a candidate's socket by accident.
 */

export const INTERVIEW_ROLES = ["interviewer", "candidate", "observer"] as const;
export const interviewRoleSchema = z.enum(INTERVIEW_ROLES);
export type InterviewRole = z.infer<typeof interviewRoleSchema>;

export const INTERVIEW_ROLE_NAMES: Record<InterviewRole, string> = {
  interviewer: "Interviewer",
  candidate: "Candidate",
  observer: "Observer",
};

export const INTERVIEW_STATUSES = ["active", "ended"] as const;
export const interviewStatusSchema = z.enum(INTERVIEW_STATUSES);
export type InterviewStatus = z.infer<typeof interviewStatusSchema>;

export const DIFFICULTIES = ["easy", "medium", "hard"] as const;

export const requirementsSchema = z.object({
  functional: z.array(z.string()),
  nonFunctional: z.array(z.string()),
});
export type Requirements = z.infer<typeof requirementsSchema>;

/** A question as interviewers see it (hints included). Never sent to candidates. */
export const interviewQuestionSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,60}$/),
  title: z.string().min(1).max(120),
  prompt: z.string().min(1).max(2000),
  difficulty: z.enum(DIFFICULTIES),
  tags: z.array(z.string()),
  requirements: requirementsSchema,
  hints: z.array(z.string().min(1).max(500)).min(1).max(8),
});
export type InterviewQuestion = z.infer<typeof interviewQuestionSchema>;

/** What a candidate sees of the question. */
export const publicQuestionSchema = interviewQuestionSchema.pick({
  id: true,
  title: true,
  prompt: true,
  requirements: true,
});
export type PublicQuestion = z.infer<typeof publicQuestionSchema>;

// ── Timer ─────────────────────────────────────────────────────────────────────────────────

/**
 * The countdown, stored on the server. Clients compute what to show from these fields and the
 * server's clock (`serverNow`), so every participant sees the same time.
 */
export const interviewTimerSchema = z.object({
  durationMs: z.number().int().nonnegative(),
  startedAt: z.number().int(),
  /** Set while paused. */
  pausedAt: z.number().int().nullable(),
  /** Total time spent paused before `pausedAt`. */
  pausedMs: z.number().int().nonnegative(),
  endedAt: z.number().int().nullable(),
});
export type InterviewTimer = z.infer<typeof interviewTimerSchema>;

/** Running time so far (pauses excluded), frozen once paused or ended. */
export function elapsedMs(timer: InterviewTimer, now: number): number {
  const until = timer.endedAt ?? timer.pausedAt ?? now;
  return Math.max(0, until - timer.startedAt - timer.pausedMs);
}

/** Time left; negative once over time. */
export function remainingMs(timer: InterviewTimer, now: number): number {
  return timer.durationMs - elapsedMs(timer, now);
}

/** "12:05", or "-0:30" once over time. */
export function formatCountdown(ms: number): string {
  const negative = ms < 0;
  const total = Math.ceil(Math.abs(ms) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${negative ? "-" : ""}${String(minutes)}:${String(seconds).padStart(2, "0")}`;
}

// ── Public state (every socket in the room) ─────────────────────────────────────────────────

export const participantSchema = z.object({
  userId: z.uuid(),
  name: z.string(),
  role: interviewRoleSchema,
});
export type Participant = z.infer<typeof participantSchema>;

export const revealedHintSchema = z.object({
  index: z.number().int().nonnegative(),
  text: z.string(),
});

export const publicInterviewStateSchema = z.object({
  interviewId: z.uuid(),
  boardId: z.uuid(),
  /** Increases with every change; clients ignore states older than the one they have. */
  version: z.number().int().nonnegative(),
  status: interviewStatusSchema,
  question: publicQuestionSchema,
  revealedHints: z.array(revealedHintSchema),
  timer: interviewTimerSchema,
  participants: z.array(participantSchema),
  /** The server's clock when this was sent (epoch ms), to correct for client clock skew. */
  serverNow: z.number().int(),
});
export type PublicInterviewState = z.infer<typeof publicInterviewStateSchema>;

/** True when `next` should replace `current` (same interview and newer, or a newer interview). */
export function isNewerState(
  current: PublicInterviewState | null,
  next: PublicInterviewState,
): boolean {
  if (current === null) return true;
  if (current.interviewId === next.interviewId) return next.version > current.version;
  return next.timer.startedAt >= current.timer.startedAt;
}

// ── Requests ──────────────────────────────────────────────────────────────────────────────

export const startInterviewSchema = z.object({
  questionId: z.string().min(1).max(60),
  durationMinutes: z.number().int().min(5).max(180),
  /** People on the board and their roles; the caller is always an interviewer. */
  participants: z
    .array(z.object({ userId: z.uuid(), role: interviewRoleSchema }))
    .max(20)
    .refine((list) => new Set(list.map((p) => p.userId)).size === list.length, {
      message: "each person can have only one role",
    })
    .refine((list) => list.filter((p) => p.role === "candidate").length <= 1, {
      message: "an interview has at most one candidate",
    }),
});
export type StartInterviewRequest = z.infer<typeof startInterviewSchema>;

export const updateParticipantsSchema = z.object({
  participants: startInterviewSchema.shape.participants,
});

export const timerActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("extend"), minutes: z.number().int().min(1).max(60) }),
]);
export type TimerAction = z.infer<typeof timerActionSchema>;

export const endInterviewSchema = z.object({}).strict();

// ── Notes (interviewers only) ───────────────────────────────────────────────────────────────

export const NOTE_MAX_LENGTH = 5000;
export const noteBodySchema = z.object({ body: z.string().trim().min(1).max(NOTE_MAX_LENGTH) });

export const interviewNoteSchema = z.object({
  id: z.uuid(),
  authorId: z.uuid().nullable(),
  authorName: z.string(),
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type InterviewNote = z.infer<typeof interviewNoteSchema>;
export const noteListSchema = z.object({ notes: z.array(interviewNoteSchema) });

// ── Scorecard (interviewers only) ───────────────────────────────────────────────────────────

export const RUBRIC_DIMENSIONS = [
  {
    id: "requirements",
    name: "Requirements & scoping",
    description: "Clarifies functional and non-functional requirements, estimates scale.",
  },
  {
    id: "high_level_design",
    name: "High-level design",
    description: "A coherent end-to-end architecture that meets the requirements.",
  },
  {
    id: "data_model",
    name: "Data model & storage",
    description: "Sensible schema, storage choices, partitioning and access patterns.",
  },
  {
    id: "scalability",
    name: "Scalability & reliability",
    description: "Finds bottlenecks and single points of failure; scales and degrades well.",
  },
  {
    id: "communication",
    name: "Trade-offs & communication",
    description: "Explains choices and alternatives clearly, responds well to hints.",
  },
] as const;
export type RubricDimensionId = (typeof RUBRIC_DIMENSIONS)[number]["id"];
export const rubricDimensionIdSchema = z.enum(
  RUBRIC_DIMENSIONS.map((d) => d.id) as [RubricDimensionId, ...RubricDimensionId[]],
);

export const SCORE_LABELS: Record<1 | 2 | 3 | 4, string> = {
  1: "Poor",
  2: "Mixed",
  3: "Good",
  4: "Excellent",
};

export const RECOMMENDATIONS = ["strong_no", "no", "yes", "strong_yes"] as const;
export const recommendationSchema = z.enum(RECOMMENDATIONS);
export type Recommendation = z.infer<typeof recommendationSchema>;
export const RECOMMENDATION_NAMES: Record<Recommendation, string> = {
  strong_no: "Strong no hire",
  no: "No hire",
  yes: "Hire",
  strong_yes: "Strong hire",
};

export const dimensionScoreSchema = z.object({
  score: z.number().int().min(1).max(4).nullable(),
  comment: z.string().trim().max(2000),
});
export type DimensionScore = z.infer<typeof dimensionScoreSchema>;

export const scorecardInputSchema = z.object({
  scores: z.partialRecord(rubricDimensionIdSchema, dimensionScoreSchema),
  recommendation: recommendationSchema.nullable(),
  summary: z.string().trim().max(NOTE_MAX_LENGTH),
  /** true = final. A submitted scorecard can still be edited by its author. */
  submit: z.boolean(),
});
export type ScorecardInput = z.infer<typeof scorecardInputSchema>;

export const scorecardSchema = z.object({
  interviewerId: z.uuid(),
  interviewerName: z.string(),
  scores: z.partialRecord(rubricDimensionIdSchema, dimensionScoreSchema),
  recommendation: recommendationSchema.nullable(),
  summary: z.string(),
  submittedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type Scorecard = z.infer<typeof scorecardSchema>;

/** Average of the scored dimensions (1–4), or null when nothing is scored. */
export function averageScore(scores: Scorecard["scores"]): number | null {
  const values = Object.values(scores).flatMap((s) => (s.score ? [s.score] : []));
  if (values.length === 0) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}

// ── Interviewer view, summary, replay ───────────────────────────────────────────────────────

/** GET /boards/:id/interview: the board's current interview as the caller may see it. */
export const interviewViewSchema = z.object({
  state: publicInterviewStateSchema,
  /** The caller's role; null = not a participant (sees what a candidate sees). */
  myRole: interviewRoleSchema.nullable(),
  /** Interviewers only; null for everyone else. */
  question: interviewQuestionSchema.nullable(),
});
export type InterviewView = z.infer<typeof interviewViewSchema>;
export const interviewViewResponseSchema = z.object({ interview: interviewViewSchema.nullable() });

export const questionListSchema = z.object({ questions: z.array(interviewQuestionSchema) });

export const MARKER_KINDS = [
  "started",
  "ended",
  "hint_revealed",
  "timer_paused",
  "timer_resumed",
  "timer_extended",
  "review_started",
  "review_completed",
  "note",
] as const;
export const replayMarkerSchema = z.object({
  kind: z.enum(MARKER_KINDS),
  /** Epoch ms. */
  at: z.number().int(),
  label: z.string(),
  /** Review id or note id, when the marker refers to one. */
  refId: z.string().nullable(),
});
export type ReplayMarker = z.infer<typeof replayMarkerSchema>;

/** One step of the board's history: Yjs update(s) stored together at `t` (epoch ms). */
export const replayFrameSchema = z.object({ t: z.number().int(), u: z.string() });
export const replayBundleSchema = z.object({
  interviewId: z.uuid(),
  startedAt: z.number().int(),
  endedAt: z.number().int(),
  /** Base64 Yjs state of the board just before the interview started. */
  base: z.string(),
  frames: z.array(replayFrameSchema),
  markers: z.array(replayMarkerSchema),
});
export type ReplayBundle = z.infer<typeof replayBundleSchema>;

/** Summary-page data except the AI reviews (their schema lives in @whiteboard/graph). */
export const interviewSummaryBaseSchema = z.object({
  interviewId: z.uuid(),
  boardId: z.uuid(),
  boardTitle: z.string(),
  status: interviewStatusSchema,
  question: interviewQuestionSchema,
  revealedHints: z.array(z.number().int().nonnegative()),
  timer: interviewTimerSchema,
  participants: z.array(participantSchema),
  startedByName: z.string(),
  /** The caller's role; null = viewing through a summary share link. */
  myRole: interviewRoleSchema.nullable(),
  scorecards: z.array(scorecardSchema),
  /** Interviewers only; null for everyone else. */
  notes: z.array(interviewNoteSchema).nullable(),
  canShare: z.boolean(),
});

export const summaryShareLinkSchema = z.object({
  id: z.uuid(),
  createdAt: z.string(),
});
export const createdSummaryShareLinkSchema = summaryShareLinkSchema.extend({
  /** Returned once; only a hash is stored. */
  token: z.string(),
});
export const summaryShareLinkListSchema = z.object({ links: z.array(summaryShareLinkSchema) });
