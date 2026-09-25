import type { DesignGraph, Finding } from "@whiteboard/graph";

/**
 * Turns the extracted graph into the compact data block sent to Claude.
 *
 * - Shapes get short references ("n1", "e1", "g1") instead of UUIDs: fewer tokens and fewer
 *   copying mistakes. The server maps them back; the model never sees canvas ids.
 * - Every piece of user text (labels, problem statement, requirements) is untrusted. It is
 *   cleaned (control characters removed, length capped) and only ever placed inside the
 *   JSON data block, never in the instructions.
 */

export const LABEL_MAX = 80;

export interface RefMap {
  /** Reference → canvas shape id to highlight (a component, or the arrow for a connection). */
  toShape: Map<string, string>;
  /** Lower-cased label → node id, for labels that identify exactly one component. */
  uniqueLabels: Map<string, string>;
  /** Canvas shape ids present in the graph (a model that echoes a real id is accepted). */
  shapeIds: Set<string>;
  ruleIds: Set<string>;
}

export interface BoardData {
  /** JSON (with `<` and `>` escaped so text can't close the surrounding tag). */
  json: string;
  refs: RefMap;
}

/** Removes control/format characters and collapses whitespace; caps the length. */
export function cleanText(value: string, max: number): string {
  const cleaned = value
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** Keeps line breaks (requirements are often lists) but removes other control characters. */
export function cleanMultiline(value: string, max: number): string {
  const cleaned = value
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\P{Cc}\n]+/gu, " ")
    .replace(/\p{Cf}+/gu, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** JSON that is safe to embed between XML-style tags. */
export function embeddableJson(value: unknown): string {
  return JSON.stringify(value, null, 1)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

export function buildBoardData(
  graph: DesignGraph,
  ruleFindings: readonly Finding[],
  context: { problemStatement: string; requirements: string },
): BoardData {
  const toShape = new Map<string, string>();
  const nodeRef = new Map<string, string>();
  const arrowRefs = new Map<string, string[]>();
  const groupRef = new Map<string, string>();
  const labelCounts = new Map<string, string[]>();

  const components = graph.nodes.map((node, i) => {
    const ref = `n${String(i + 1)}`;
    nodeRef.set(node.id, ref);
    toShape.set(ref, node.id);
    const label = cleanText(node.label, LABEL_MAX);
    const key = label.toLowerCase();
    labelCounts.set(key, [...(labelCounts.get(key) ?? []), node.id]);
    let group: string | undefined;
    if (node.props.groupId !== null) {
      group = groupRef.get(node.props.groupId);
      if (group === undefined) {
        group = `g${String(groupRef.size + 1)}`;
        groupRef.set(node.props.groupId, group);
      }
    }
    return {
      ref,
      kind: node.kind,
      label,
      ...(node.props.unlabeled ? { unlabeled: true } : {}),
      ...(node.props.instances > 1 ? { instances: node.props.instances } : {}),
      ...(node.props.engine ? { engine: node.props.engine } : {}),
      ...(node.props.role ? { role: node.props.role } : {}),
      ...(node.props.mode ? { mode: node.props.mode } : {}),
      ...(group ? { group } : {}),
    };
  });

  const connections = graph.edges.map((edge, i) => {
    const ref = `e${String(i + 1)}`;
    toShape.set(ref, edge.arrowId);
    arrowRefs.set(edge.arrowId, [...(arrowRefs.get(edge.arrowId) ?? []), ref]);
    const label = cleanText(edge.label, LABEL_MAX);
    return {
      ref,
      from: nodeRef.get(edge.from) ?? edge.from,
      to: nodeRef.get(edge.to) ?? edge.to,
      type: edge.edgeType,
      ...(label ? { label } : {}),
    };
  });

  const refsFor = (shapeId: string): string[] => {
    const node = nodeRef.get(shapeId);
    if (node) return [node];
    return arrowRefs.get(shapeId) ?? [];
  };

  const rules = ruleFindings.map((finding) => ({
    rule: finding.ruleId,
    severity: finding.severity,
    title: finding.title,
    explanation: finding.explanation,
    refs: [...new Set(finding.shapeIds.flatMap(refsFor))],
  }));

  const uniqueLabels = new Map<string, string>();
  for (const [label, ids] of labelCounts) {
    const [only] = ids;
    if (ids.length === 1 && only !== undefined && label.length > 0) uniqueLabels.set(label, only);
  }

  const data = {
    problem_statement: cleanMultiline(context.problemStatement, 2000) || null,
    stated_requirements: cleanMultiline(context.requirements, 2000) || null,
    components,
    connections,
    rule_engine_findings: rules,
    shapes_not_analyzed: graph.ignored.length,
  };

  return {
    json: embeddableJson(data),
    refs: {
      toShape,
      uniqueLabels,
      shapeIds: new Set([...graph.nodes.map((n) => n.id), ...graph.edges.map((e) => e.arrowId)]),
      ruleIds: new Set(ruleFindings.map((f) => f.ruleId)),
    },
  };
}
