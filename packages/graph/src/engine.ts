import { GraphIndex } from "./context";
import { extractGraph } from "./extract";
import { DEFAULT_CHECK_OPTIONS, type CheckOptions, type Rule } from "./rule";
import { clientDirectDbRule } from "./rules/clientDirectDb";
import { dbSpofRule } from "./rules/dbSpof";
import { deepSyncChainRule } from "./rules/deepSyncChain";
import { disconnectedRule } from "./rules/disconnected";
import { noLoadBalancerRule } from "./rules/noLoadBalancer";
import { queueNoDlqRule } from "./rules/queueNoDlq";
import { readPathNoCacheRule } from "./rules/readPathNoCache";
import { storageNoCdnRule } from "./rules/storageNoCdn";
import { syncCycleRule } from "./rules/syncCycle";
import { SEVERITIES, type DesignGraph, type Finding } from "./types";

/** Every rule, in the order findings of equal severity are listed. */
export const DEFAULT_RULES: readonly Rule[] = [
  dbSpofRule,
  clientDirectDbRule,
  syncCycleRule,
  noLoadBalancerRule,
  readPathNoCacheRule,
  deepSyncChainRule,
  queueNoDlqRule,
  storageNoCdnRule,
  disconnectedRule,
];

export interface RuleError {
  ruleId: string;
  message: string;
}

export interface RunRulesOptions extends Partial<CheckOptions> {
  rules?: readonly Rule[];
}

export interface RuleResults {
  /** Sorted: severity, then rule order, then board position of the first shape. */
  findings: Finding[];
  /** Rules that threw. Their findings are missing; the others are unaffected. */
  ruleErrors: RuleError[];
}

export function runRules(graph: DesignGraph, options: RunRulesOptions = {}): RuleResults {
  const { rules = DEFAULT_RULES, ...overrides } = options;
  const checkOptions: CheckOptions = { ...DEFAULT_CHECK_OPTIONS, ...overrides };
  const index = new GraphIndex(graph);
  const findings = new Map<string, Finding>();
  const ruleErrors: RuleError[] = [];
  const ruleOrder = new Map(rules.map((rule, i) => [rule.id, i]));

  for (const rule of rules) {
    try {
      for (const finding of rule.check({ graph: index, options: checkOptions })) {
        findings.set(finding.id, finding);
      }
    } catch (error) {
      // A bug in one rule must not hide every other finding (or break the editor).
      ruleErrors.push({
        ruleId: rule.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const severityRank = (finding: Finding) => SEVERITIES.indexOf(finding.severity);
  const firstPosition = (finding: Finding) =>
    Math.min(...finding.shapeIds.map((id) => index.position(id)));
  const sorted = [...findings.values()].sort(
    (a, b) =>
      severityRank(a) - severityRank(b) ||
      (ruleOrder.get(a.ruleId) ?? 0) - (ruleOrder.get(b.ruleId) ?? 0) ||
      firstPosition(a) - firstPosition(b) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return { findings: sorted, ruleErrors };
}

export interface DesignCheckResult extends RuleResults {
  graph: DesignGraph;
}

/** Board shapes → graph → findings, in one call. Pure; never throws for any input. */
export function checkDesign(
  shapes: Iterable<unknown>,
  options: RunRulesOptions = {},
): DesignCheckResult {
  const graph = extractGraph(shapes);
  return { graph, ...runRules(graph, options) };
}
