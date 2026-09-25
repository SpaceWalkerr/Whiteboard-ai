import { SEVERITIES, type AiReview, type ReviewFinding } from "@whiteboard/graph";
import type { EvalCase, ExpectedFlaw } from "./fixtures";

/** Deterministic grading (no LLM judge): same review in, same score out. */

export interface FlawResult {
  id: string;
  caught: boolean;
  /** The finding that caught it. */
  by: string | null;
}

export interface CaseResult {
  name: string;
  passed: boolean;
  flaws: FlawResult[];
  findingCount: number;
  /** Findings whose shapes aren't on the board (must always be 0; the server repairs them). */
  invalidReferences: number;
}

function atLeast(severity: ReviewFinding["severity"], min: ReviewFinding["severity"]): boolean {
  return SEVERITIES.indexOf(severity) <= SEVERITIES.indexOf(min);
}

export function catches(finding: ReviewFinding, flaw: ExpectedFlaw): boolean {
  const text = `${finding.title}\n${finding.explanation}\n${finding.suggestion}`;
  return (
    finding.shapeIds.some((id) => flaw.shapes.includes(id)) &&
    atLeast(finding.severity, flaw.minSeverity) &&
    flaw.keywords.test(text)
  );
}

export function gradeCase(testCase: EvalCase, review: AiReview | null): CaseResult {
  const shapeIds = new Set(testCase.shapes.map((s) => s.id));
  const findings = review?.findings ?? [];
  const flaws = testCase.flaws.map((flaw) => {
    const by = findings.find((f) => catches(f, flaw));
    return { id: flaw.id, caught: by !== undefined, by: by?.id ?? null };
  });
  return {
    name: testCase.name,
    passed: review !== null && flaws.every((f) => f.caught),
    flaws,
    findingCount: findings.length,
    invalidReferences: findings.filter((f) => f.shapeIds.some((id) => !shapeIds.has(id))).length,
  };
}
