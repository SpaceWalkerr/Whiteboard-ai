import type { GraphIndex } from "./context";
import type { Finding, Severity } from "./types";

export interface CheckOptions {
  /** Longest acceptable chain of synchronous service-to-service calls, in hops. */
  maxSyncDepth: number;
}

export const DEFAULT_CHECK_OPTIONS: CheckOptions = { maxSyncDepth: 3 };

export interface RuleContext {
  graph: GraphIndex;
  options: CheckOptions;
}

/** A rule is a small pure function from the graph to findings. It must not mutate anything. */
export interface Rule {
  id: string;
  /** One line describing what the rule looks for (shown in docs / future settings). */
  description: string;
  check: (context: RuleContext) => Finding[];
}

export interface FindingText {
  title: string;
  explanation: string;
  suggestion: string;
}

export function makeFinding(
  ruleId: string,
  severity: Severity,
  shapeIds: readonly string[],
  text: FindingText,
): Finding {
  const unique = [...new Set(shapeIds)];
  return {
    id: `${ruleId}:${[...unique].sort().join(",")}`,
    ruleId,
    severity,
    shapeIds: unique,
    ...text,
  };
}

/** Quotes a component's label for use in a sentence. */
export function named(label: string): string {
  return `“${label}”`;
}
