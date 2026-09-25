import {
  isSystemShape,
  shapeSchema,
  type ArrowShape,
  type Shape,
  type SystemShape,
} from "@whiteboard/shared/board";
import { explicitInstanceCount, instanceLabelKey } from "./instances";
import {
  COMPONENT_KIND_LABELS,
  type DesignGraph,
  type GraphEdge,
  type GraphNode,
  type IgnoredReason,
  type IgnoredShape,
} from "./types";

/**
 * Board → typed architecture graph.
 *
 * Takes plain shape records rather than a Y.Doc so this package stays free of Yjs and I/O: the
 * web app passes `BoardSnapshot.ordered`, the server (Phase 7) `doc.getMap("shapes").toJSON()`
 * values. Input is `unknown` and validated here, so any board — including a corrupt one —
 * produces a graph instead of an exception.
 *
 *   - System-design shapes become nodes; everything else is reported in `ignored`.
 *   - Arrows between components become edges. An arrow bound to a plain shape inside a group
 *     (e.g. a frame drawn around three service instances) resolves to every component in that
 *     group, one edge each.
 *   - Arrows with a free end, or bound to a shape that doesn't exist, are reported, not guessed.
 */
export function extractGraph(shapes: Iterable<unknown>): DesignGraph {
  const ignored: IgnoredShape[] = [];
  const valid = new Map<string, Shape>();

  for (const raw of shapes) {
    const parsed = shapeSchema.safeParse(raw);
    if (!parsed.success) {
      ignored.push({
        shapeId: stringField(raw, "id"),
        shapeType: stringField(raw, "type"),
        reason: "invalid",
      });
      continue;
    }
    const shape = parsed.data;
    if (valid.has(shape.id)) {
      ignored.push({ shapeId: shape.id, shapeType: shape.type, reason: "duplicate_id" });
      continue;
    }
    valid.set(shape.id, shape);
  }

  const components: SystemShape[] = [];
  const componentsByGroup = new Map<string, string[]>();
  for (const shape of valid.values()) {
    if (!isSystemShape(shape)) continue;
    components.push(shape);
    if (shape.groupId !== null) {
      const members = componentsByGroup.get(shape.groupId) ?? [];
      members.push(shape.id);
      componentsByGroup.set(shape.groupId, members);
    }
  }
  const nodes = toNodes(components);

  const edges: GraphEdge[] = [];
  for (const shape of valid.values()) {
    if (isSystemShape(shape)) continue;
    if (shape.type !== "arrow") {
      ignored.push({ shapeId: shape.id, shapeType: shape.type, reason: "not_a_component" });
      continue;
    }
    const resolved = arrowEdges(shape, valid, componentsByGroup);
    if (typeof resolved === "string") {
      ignored.push({ shapeId: shape.id, shapeType: shape.type, reason: resolved });
    } else {
      edges.push(...resolved);
    }
  }

  return { nodes, edges, ignored };
}

function stringField(raw: unknown, key: string): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value: unknown = (raw as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;
}

function toNodes(components: readonly SystemShape[]): GraphNode[] {
  // Horizontally scaled components: same kind + same label apart from a trailing number.
  const setSizes = new Map<string, number>();
  const setKey = (shape: SystemShape) => {
    const key = instanceLabelKey(shape.label);
    return key === "" ? null : `${shape.type}\u0000${key}`;
  };
  for (const shape of components) {
    const key = setKey(shape);
    if (key !== null) setSizes.set(key, (setSizes.get(key) ?? 0) + 1);
  }

  return components.map((shape) => {
    const label = shape.label.trim();
    const key = setKey(shape);
    const inSet = key === null ? 1 : (setSizes.get(key) ?? 1);
    const explicit = explicitInstanceCount(label) ?? 1;
    const node: GraphNode = {
      id: shape.id,
      kind: shape.type,
      label: label === "" ? COMPONENT_KIND_LABELS[shape.type] : label,
      props: {
        unlabeled: label === "",
        instances: Math.max(inSet, explicit),
        groupId: shape.groupId,
      },
    };
    if (shape.type === "database") {
      node.props.engine = shape.engine;
      node.props.role = shape.role;
    } else if (shape.type === "queue") {
      node.props.mode = shape.mode;
    }
    return node;
  });
}

interface ResolvedEnd {
  ids: readonly string[];
  /** True when the arrow was bound to a component itself (not through its group). */
  direct: boolean;
}

function resolveEnd(
  shapeId: string | null,
  shapes: ReadonlyMap<string, Shape>,
  componentsByGroup: ReadonlyMap<string, readonly string[]>,
): ResolvedEnd | IgnoredReason {
  if (shapeId === null) return "dangling_arrow";
  const target = shapes.get(shapeId);
  if (!target) return "dangling_arrow";
  if (isSystemShape(target)) return { ids: [target.id], direct: true };
  if (target.type !== "arrow" && target.groupId !== null) {
    const members = componentsByGroup.get(target.groupId);
    if (members && members.length > 0) return { ids: members, direct: false };
  }
  return "arrow_to_non_component";
}

function arrowEdges(
  arrow: ArrowShape,
  shapes: ReadonlyMap<string, Shape>,
  componentsByGroup: ReadonlyMap<string, readonly string[]>,
): GraphEdge[] | IgnoredReason {
  const from = resolveEnd(arrow.fromShapeId, shapes, componentsByGroup);
  const to = resolveEnd(arrow.toShapeId, shapes, componentsByGroup);
  // A free end is the more fundamental problem, so it wins when both ends are bad.
  if (from === "dangling_arrow" || to === "dangling_arrow") return "dangling_arrow";
  if (typeof from === "string") return from;
  if (typeof to === "string") return to;

  const pairs: [string, string][] = [];
  for (const source of from.ids) {
    for (const target of to.ids) {
      // A self-loop drawn on one component is meaningful (a service calling itself); one that
      // only appears because both ends resolve through the same group is not.
      if (source === target && !(from.direct && to.direct)) continue;
      pairs.push([source, target]);
    }
  }
  if (pairs.length === 0) return "arrow_to_non_component";

  const label = arrow.label.trim();
  return pairs.map(([source, target]) => ({
    id: pairs.length === 1 ? arrow.id : `${arrow.id}:${source}->${target}`,
    arrowId: arrow.id,
    from: source,
    to: target,
    edgeType: arrow.edgeType,
    label,
  }));
}
