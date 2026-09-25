import { z } from "zod";
import { designGraphSchema, findingSchema, severitySchema, type DesignGraph } from "./types";

/**
 * The AI design review contract (Phase 7): what the server returns and stores, the streamed
 * progress events, live hints, and the comparison between two reviews. Shared by the server
 * (which validates Claude's output against these) and the web app (which validates responses).
 */

export const REVIEW_DIMENSIONS = [
  "scalability",
  "reliability",
  "data_design",
  "security",
  "cost",
] as const;
export const reviewDimensionSchema = z.enum(REVIEW_DIMENSIONS);
export type ReviewDimension = z.infer<typeof reviewDimensionSchema>;

export const REVIEW_DIMENSION_LABELS: Record<ReviewDimension, string> = {
  scalability: "Scalability",
  reliability: "Reliability",
  data_design: "Data design",
  security: "Security",
  cost: "Cost",
};

/** Upper bounds on free text the user sends with a review (it is untrusted model input). */
export const PROBLEM_STATEMENT_MAX = 2000;
export const REQUIREMENTS_MAX = 2000;

export const reviewRequestSchema = z.object({
  /** E.g. "Design a URL shortener, 100M URLs/day". */
  problemStatement: z.string().trim().max(PROBLEM_STATEMENT_MAX).default(""),
  /** Requirements the user has stated (scale, latency, consistency…). */
  requirements: z.string().trim().max(REQUIREMENTS_MAX).default(""),
});
export type ReviewRequest = z.infer<typeof reviewRequestSchema>;

/** One AI finding. Every finding points at shapes that exist in the reviewed graph. */
export const reviewFindingSchema = z.object({
  /** Position-based id within the review ("f1", "f2", …): the pin number on the canvas. */
  id: z.string().min(1).max(16),
  severity: severitySchema,
  dimension: reviewDimensionSchema,
  title: z.string().min(1).max(200),
  explanation: z.string().min(1).max(2000),
  shapeIds: z.array(z.string().min(1).max(200)).min(1).max(50),
  suggestion: z.string().min(1).max(2000),
  /** The rule-engine finding this confirms, if any. */
  ruleId: z.string().max(64).nullable(),
});
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

export const reviewScoresSchema = z.object({
  scalability: z.number().int().min(1).max(10),
  reliability: z.number().int().min(1).max(10),
  data_design: z.number().int().min(1).max(10),
  security: z.number().int().min(1).max(10),
  cost: z.number().int().min(1).max(10),
});
export type ReviewScores = z.infer<typeof reviewScoresSchema>;

export const aiReviewSchema = z.object({
  summary: z.string().min(1).max(3000),
  scores: reviewScoresSchema,
  findings: z.array(reviewFindingSchema).max(30),
  followUpQuestions: z.array(z.string().min(1).max(500)).max(10),
});
export type AiReview = z.infer<typeof aiReviewSchema>;

export const reviewStatusSchema = z.enum(["running", "completed", "failed"]);

/** A stored review as the API returns it. */
export const reviewRecordSchema = z.object({
  id: z.uuid(),
  boardId: z.uuid(),
  status: reviewStatusSchema,
  requestedBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  problemStatement: z.string(),
  requirements: z.string(),
  model: z.string(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  /** User-safe failure code for failed reviews. */
  errorCode: z.string().nullable(),
  review: aiReviewSchema.nullable(),
  /** The graph the review was run against (shape ids in findings refer to it). */
  graph: designGraphSchema,
  ruleFindings: z.array(findingSchema),
});
export type ReviewRecord = z.infer<typeof reviewRecordSchema>;

export const reviewSummarySchema = z.object({
  id: z.uuid(),
  status: reviewStatusSchema,
  createdAt: z.string(),
  requestedByName: z.string().nullable(),
  problemStatement: z.string(),
  findingCount: z.number().int().nonnegative(),
  /** Mean of the dimension scores, one decimal; null unless completed. */
  overallScore: z.number().nullable(),
});
export type ReviewSummary = z.infer<typeof reviewSummarySchema>;

export const reviewListSchema = z.object({ reviews: z.array(reviewSummarySchema) });

export const REVIEW_STAGES = ["preparing", "reviewing", "validating"] as const;
export const reviewStageSchema = z.enum(REVIEW_STAGES);
export type ReviewStage = z.infer<typeof reviewStageSchema>;

/**
 * Server-sent events of POST /boards/:id/reviews. Findings are sent only in `done`, after
 * validation, so the UI never shows a shape reference the server hasn't checked.
 */
export const reviewStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stage"), stage: reviewStageSchema }),
  z.object({ type: z.literal("progress"), outputTokens: z.number().int().nonnegative() }),
  z.object({ type: z.literal("done"), review: reviewRecordSchema }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type ReviewStreamEvent = z.infer<typeof reviewStreamEventSchema>;

/** A live hint (Pro+): short, about specific shapes, dismissible. */
export const hintSchema = z.object({
  /** Stable for the same text on the same shapes, so a dismissed hint stays dismissed. */
  id: z.string().min(1).max(200),
  severity: severitySchema,
  text: z.string().min(1).max(300),
  shapeIds: z.array(z.string().min(1).max(200)).min(1).max(20),
});
export type Hint = z.infer<typeof hintSchema>;

export const hintsResponseSchema = z.object({
  hints: z.array(hintSchema).max(3),
  /** True when the server skipped the call (same graph as last time, or nothing to say). */
  skipped: z.boolean(),
});
export type HintsResponse = z.infer<typeof hintsResponseSchema>;

export function overallScore(scores: ReviewScores): number {
  const values = REVIEW_DIMENSIONS.map((d) => scores[d]);
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}

/**
 * Identifies the parts of a graph that matter to a design review: component kinds, labels,
 * database/queue settings and connections. Moving or restyling shapes doesn't change it, so
 * live hints are only requested after a meaningful change.
 */
export function graphFingerprint(graph: DesignGraph): string {
  const nodes = graph.nodes
    .map((n) =>
      [
        n.id,
        n.kind,
        n.label.trim().toLowerCase(),
        n.props.engine ?? "",
        n.props.role ?? "",
        n.props.mode ?? "",
        n.props.groupId ?? "",
      ].join("|"),
    )
    .sort();
  const edges = graph.edges
    .map((e) => [e.from, e.to, e.edgeType, e.label.trim().toLowerCase()].join("|"))
    .sort();
  return `${nodes.join(";")}#${edges.join(";")}`;
}

// ── Comparing two reviews ──────────────────────────────────────────────────────────────────

export type FindingChange = "new" | "persisting";

export interface ReviewDiff {
  /** Change per finding of the newer review, by finding id. */
  changes: Map<string, FindingChange>;
  /** Findings of the older review with no counterpart in the newer one. */
  resolved: ReviewFinding[];
  /** Newer minus older, per dimension. */
  scoreDeltas: ReviewScores;
}

/** Share of the smaller set that also appears in the other set. */
function overlap(a: readonly string[], b: readonly string[]): number {
  const small = a.length <= b.length ? a : b;
  const large = new Set(a.length <= b.length ? b : a);
  if (small.length === 0) return 0;
  return small.filter((id) => large.has(id)).length / small.length;
}

/**
 * Matches findings of two reviews of the same board. The model words titles differently
 * each time, so a finding "persists" when an older finding is about the same dimension (or
 * confirms the same rule) and at least half of the shapes they point at are shared. Each
 * older finding matches at most one newer finding (greedy, best overlap first).
 */
export function diffReviews(previous: AiReview, current: AiReview): ReviewDiff {
  const candidates: { cur: number; prev: number; score: number }[] = [];
  current.findings.forEach((c, ci) => {
    previous.findings.forEach((p, pi) => {
      const sameTopic = c.dimension === p.dimension || (c.ruleId !== null && c.ruleId === p.ruleId);
      const score = overlap(c.shapeIds, p.shapeIds);
      if (sameTopic && score >= 0.5) candidates.push({ cur: ci, prev: pi, score });
    });
  });
  candidates.sort((a, b) => b.score - a.score || a.cur - b.cur || a.prev - b.prev);

  const matchedCur = new Set<number>();
  const matchedPrev = new Set<number>();
  for (const { cur, prev } of candidates) {
    if (matchedCur.has(cur) || matchedPrev.has(prev)) continue;
    matchedCur.add(cur);
    matchedPrev.add(prev);
  }

  const changes = new Map<string, FindingChange>();
  current.findings.forEach((f, i) => changes.set(f.id, matchedCur.has(i) ? "persisting" : "new"));
  const resolved = previous.findings.filter((_, i) => !matchedPrev.has(i));
  const delta = (d: ReviewDimension) => current.scores[d] - previous.scores[d];
  const scoreDeltas: ReviewScores = {
    scalability: delta("scalability"),
    reliability: delta("reliability"),
    data_design: delta("data_design"),
    security: delta("security"),
    cost: delta("cost"),
  };
  return { changes, resolved, scoreDeltas };
}
