/**
 * Board → typed architecture graph, and a deterministic rules engine that finds obvious design
 * problems without AI. Pure TypeScript with no I/O; used by the web app (the "Check design"
 * panel) and, from Phase 7, by the server as the grounding for the AI review.
 */

/**
 * Version of the graph format this package produces. Bump it whenever the shape of the
 * extracted graph changes, so stored reviews can tell which format they were run against.
 */
export const GRAPH_FORMAT_VERSION = 1;

export * from "./types";
export { extractGraph } from "./extract";
export { explicitInstanceCount, instanceLabelKey } from "./instances";
export { GraphIndex } from "./context";
export {
  DEFAULT_CHECK_OPTIONS,
  makeFinding,
  type CheckOptions,
  type FindingText,
  type Rule,
  type RuleContext,
} from "./rule";
export {
  DEFAULT_RULES,
  checkDesign,
  runRules,
  type DesignCheckResult,
  type RuleError,
  type RuleResults,
  type RunRulesOptions,
} from "./engine";
export * from "./review";
