import { z } from "zod";
import { EDGE_TYPES, SYSTEM_SHAPE_TYPES, type SystemShapeType } from "@whiteboard/shared/board";

/**
 * The typed architecture graph extracted from a board, and the findings the rules engine (and,
 * from Phase 7, Claude) produce about it. These schemas are the single definition used by the
 * web app, the server and the AI boundary (Claude's output is validated against
 * `findingSchema`).
 */

export const componentKindSchema = z.enum(SYSTEM_SHAPE_TYPES);
export type ComponentKind = SystemShapeType;

/** Display names, used when a component has no label of its own. */
export const COMPONENT_KIND_LABELS: Record<ComponentKind, string> = {
  client: "Client",
  cdn: "CDN",
  load_balancer: "Load balancer",
  api_gateway: "API gateway",
  service: "Service",
  database: "Database",
  cache: "Cache",
  queue: "Queue",
  object_storage: "Object storage",
  search_index: "Search index",
  worker: "Worker",
  external_api: "External API",
};

const idSchema = z.string().min(1).max(200);

export const graphNodePropsSchema = z.object({
  /** True when the shape has no label and `label` is the kind's display name. */
  unlabeled: z.boolean(),
  /**
   * How many running instances this component stands for: shapes of the same kind sharing a
   * label ("Order service 1", "Order service 2") or an explicit count ("API ×3").
   */
  instances: z.number().int().min(1),
  groupId: idSchema.nullable(),
  engine: z.enum(["sql", "nosql"]).optional(),
  role: z.enum(["primary", "replica"]).optional(),
  mode: z.enum(["queue", "stream"]).optional(),
});
export type GraphNodeProps = z.infer<typeof graphNodePropsSchema>;

export const graphNodeSchema = z.object({
  /** The canvas shape id. */
  id: idSchema,
  kind: componentKindSchema,
  label: z.string(),
  props: graphNodePropsSchema,
});
export type GraphNode = z.infer<typeof graphNodeSchema>;

export const graphEdgeSchema = z.object({
  /** Unique per edge. Equals `arrowId` unless one arrow fans out to a group's components. */
  id: idSchema,
  /** The canvas arrow this edge comes from (what gets highlighted). */
  arrowId: idSchema,
  from: idSchema,
  to: idSchema,
  edgeType: z.enum(EDGE_TYPES),
  label: z.string(),
});
export type GraphEdge = z.infer<typeof graphEdgeSchema>;

export const IGNORED_REASONS = [
  "not_a_component",
  "invalid",
  "duplicate_id",
  "dangling_arrow",
  "arrow_to_non_component",
] as const;
export type IgnoredReason = (typeof IGNORED_REASONS)[number];

export const ignoredShapeSchema = z.object({
  /** Null when the record had no usable id (invalid data). */
  shapeId: z.string().nullable(),
  shapeType: z.string().nullable(),
  reason: z.enum(IGNORED_REASONS),
});
export type IgnoredShape = z.infer<typeof ignoredShapeSchema>;

export const designGraphSchema = z.object({
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
  /** Shapes that are not part of the graph, and why. Reported so nothing is silently lost. */
  ignored: z.array(ignoredShapeSchema),
});
export type DesignGraph = z.infer<typeof designGraphSchema>;

export const SEVERITIES = ["critical", "warning", "info"] as const;
export const severitySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof severitySchema>;

export const findingSchema = z.object({
  /** Stable for the same problem on the same shapes: `ruleId:sorted shape ids`. */
  id: z.string().min(1),
  ruleId: z.string().min(1).max(64),
  severity: severitySchema,
  title: z.string().min(1).max(200),
  explanation: z.string().min(1).max(2000),
  /** Canvas shapes (components and arrows) the finding is about. Never empty. */
  shapeIds: z.array(idSchema).min(1),
  suggestion: z.string().min(1).max(2000),
});
export type Finding = z.infer<typeof findingSchema>;
