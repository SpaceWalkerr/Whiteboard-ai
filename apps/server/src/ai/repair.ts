import { createHash } from "node:crypto";
import {
  aiReviewSchema,
  hintSchema,
  SEVERITIES,
  type AiReview,
  type Hint,
  type ReviewFinding,
} from "@whiteboard/graph";
import type { RefMap } from "./boardData";
import { lenientModelReviewSchema, modelHintsSchema } from "./prompts";

/**
 * Turns Claude's JSON into a review we can show. Shape references are the risky part: a
 * finding pointing at a shape that doesn't exist would put a pin nowhere (or on the wrong
 * shape). Each reference is resolved to a canvas shape id, or dropped; a finding with no
 * valid shape left is dropped. No second (paid) model call is made to repair anything.
 */

export class InvalidModelOutputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidModelOutputError";
  }
}

export interface RepairStats {
  /** References that matched nothing and were removed. */
  droppedRefs: number;
  /** References accepted via an exact, unique component label instead of a ref. */
  labelMatches: number;
  /** Findings removed because none of their references was valid. */
  droppedFindings: number;
}

const MAX_FINDINGS = 30;
const MAX_QUESTIONS = 10;

function truncate(value: string, max: number): string {
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function clampScore(value: number): number {
  return Math.min(10, Math.max(1, Math.round(value)));
}

/** Resolves model references to canvas shape ids (deduplicated, in order). */
export function resolveRefs(refs: readonly string[], map: RefMap, stats: RepairStats): string[] {
  const out = new Set<string>();
  for (const raw of refs) {
    const ref = raw.trim();
    const byRef = map.toShape.get(ref) ?? map.toShape.get(ref.toLowerCase());
    if (byRef !== undefined) {
      out.add(byRef);
      continue;
    }
    if (map.shapeIds.has(ref)) {
      out.add(ref);
      continue;
    }
    const byLabel = map.uniqueLabels.get(ref.toLowerCase());
    if (byLabel !== undefined) {
      stats.labelMatches += 1;
      out.add(byLabel);
      continue;
    }
    stats.droppedRefs += 1;
  }
  return [...out];
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new InvalidModelOutputError("model output is not JSON", { cause: error });
  }
}

export function repairReview(text: string, map: RefMap): { review: AiReview; stats: RepairStats } {
  const parsed = lenientModelReviewSchema.safeParse(parseJson(text));
  if (!parsed.success)
    throw new InvalidModelOutputError("model output does not match the review schema", {
      cause: parsed.error,
    });
  const raw = parsed.data;
  const stats: RepairStats = { droppedRefs: 0, labelMatches: 0, droppedFindings: 0 };

  const kept: Omit<ReviewFinding, "id">[] = [];
  for (const finding of raw.findings) {
    const shapeIds = resolveRefs(finding.refs, map, stats).slice(0, 50);
    const title = truncate(finding.title, 200);
    const explanation = truncate(finding.explanation, 2000);
    const suggestion = truncate(finding.suggestion, 2000);
    if (shapeIds.length === 0 || !title || !explanation || !suggestion) {
      stats.droppedFindings += 1;
      continue;
    }
    const ruleId = finding.rule !== null && map.ruleIds.has(finding.rule) ? finding.rule : null;
    kept.push({
      severity: finding.severity,
      dimension: finding.dimension,
      title,
      explanation,
      suggestion,
      shapeIds,
      ruleId,
    });
  }
  // Most severe first (stable, so the model's order is kept within a severity).
  const rank = (s: ReviewFinding["severity"]) => SEVERITIES.indexOf(s);
  kept.sort((a, b) => rank(a.severity) - rank(b.severity));
  if (kept.length > MAX_FINDINGS) stats.droppedFindings += kept.length - MAX_FINDINGS;

  const summary = truncate(raw.summary, 3000);
  if (!summary) throw new InvalidModelOutputError("model output has an empty summary");

  const review = {
    summary,
    scores: {
      scalability: clampScore(raw.scores.scalability),
      reliability: clampScore(raw.scores.reliability),
      data_design: clampScore(raw.scores.data_design),
      security: clampScore(raw.scores.security),
      cost: clampScore(raw.scores.cost),
    },
    findings: kept
      .slice(0, MAX_FINDINGS)
      .map((finding, i) => ({ id: `f${String(i + 1)}`, ...finding })),
    followUpQuestions: raw.follow_up_questions
      .map((q) => truncate(q, 500))
      .filter((q) => q.length > 0)
      .slice(0, MAX_QUESTIONS),
  };
  // Final gate: whatever we store and send satisfies the public contract exactly.
  const checked = aiReviewSchema.safeParse(review);
  if (!checked.success)
    throw new InvalidModelOutputError("repaired review is invalid", { cause: checked.error });
  return { review: checked.data, stats };
}

/** A dismissed hint stays dismissed while it is about the same shapes. */
export function hintId(severity: string, shapeIds: readonly string[]): string {
  const key = `${severity}:${[...shapeIds].sort().join(",")}`;
  return `h_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

export function repairHints(text: string, map: RefMap): { hints: Hint[]; stats: RepairStats } {
  const parsed = modelHintsSchema.safeParse(parseJson(text));
  if (!parsed.success)
    throw new InvalidModelOutputError("model output does not match the hints schema", {
      cause: parsed.error,
    });
  const stats: RepairStats = { droppedRefs: 0, labelMatches: 0, droppedFindings: 0 };
  const hints: Hint[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.data.hints) {
    const shapeIds = resolveRefs(raw.refs, map, stats).slice(0, 20);
    const text = truncate(raw.text, 300);
    if (shapeIds.length === 0 || !text) {
      stats.droppedFindings += 1;
      continue;
    }
    const hint = { id: hintId(raw.severity, shapeIds), severity: raw.severity, text, shapeIds };
    if (seen.has(hint.id) || !hintSchema.safeParse(hint).success) continue;
    seen.add(hint.id);
    hints.push(hint);
    if (hints.length === 3) break;
  }
  return { hints, stats };
}
