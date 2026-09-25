import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EDGE_TYPES, SYSTEM_SHAPE_TYPES, type Shape } from "@whiteboard/shared/board";
import { checkDesign, designGraphSchema, extractGraph, findingSchema } from "../src";
import { board } from "./fixtures/board";

const SHAPE_TYPES = [...SYSTEM_SHAPE_TYPES, "rectangle", "ellipse", "sticky", "text", "arrow"];

/**
 * Random boards: mostly well-formed shapes (so rules get real graphs to chew on) whose arrows
 * bind to existing ids, missing ids, other arrows, groups or nothing; mixed with corrupt
 * records — wrong types, missing fields, arbitrary JSON values.
 */
const idArb = fc.constantFrom("a", "b", "c", "d", "e", "f", "g", "h", "missing", "arrow-0");
const groupArb = fc.option(fc.constantFrom("g1", "g2"), { nil: null });
const labelArb = fc.oneof(
  fc.constantFrom(
    "",
    "API 1",
    "API 2",
    "API ×3",
    "Feed service",
    "DLQ",
    "static assets",
    "GET /feed",
    "retry",
  ),
  fc.string({ maxLength: 20 }),
);

const shapeArb = fc
  .record({
    type: fc.constantFrom(...SHAPE_TYPES),
    id: idArb,
    groupId: groupArb,
    label: labelArb,
    from: fc.option(idArb, { nil: null }),
    to: fc.option(idArb, { nil: null }),
    edgeType: fc.constantFrom(...EDGE_TYPES),
    role: fc.constantFrom("primary", "replica"),
    mode: fc.constantFrom("queue", "stream"),
  })
  .map((r) => {
    const common = {
      id: r.id,
      x: 0,
      y: 0,
      w: 100,
      h: 60,
      rotation: 0,
      zIndex: "a0",
      style: {
        fill: "#ffffff",
        stroke: "#000000",
        strokeWidth: 1,
        strokeStyle: "solid",
        fontSize: 16,
        opacity: 1,
      },
      groupId: r.groupId,
      createdBy: "prop",
      updatedAt: 0,
    };
    switch (r.type) {
      case "arrow":
        return {
          ...common,
          type: "arrow",
          fromShapeId: r.from,
          toShapeId: r.to,
          fromAnchor: "auto",
          toAnchor: "auto",
          start: { x: 0, y: 0 },
          end: { x: 1, y: 1 },
          label: r.label,
          edgeType: r.edgeType,
        };
      case "sticky":
      case "text":
        return { ...common, type: r.type, text: r.label };
      case "database":
        return { ...common, type: r.type, label: r.label, engine: "sql", role: r.role };
      case "queue":
        return { ...common, type: r.type, label: r.label, mode: r.mode };
      default:
        return { ...common, type: r.type, label: r.label };
    }
  });

const recordArb = fc.oneof(
  { weight: 8, arbitrary: shapeArb },
  // A valid-looking shape with one field broken.
  {
    weight: 1,
    arbitrary: fc
      .tuple(
        shapeArb,
        fc.constantFrom("id", "type", "x", "style", "fromShapeId", "role"),
        fc.anything(),
      )
      .map(([shape, key, value]) => ({ ...shape, [key]: value })),
  },
  { weight: 1, arbitrary: fc.anything() },
);

const boardArb = fc.array(recordArb, { maxLength: 40 });

describe("property: any board", () => {
  it("extractGraph never throws and produces a consistent graph", () => {
    fc.assert(
      fc.property(boardArb, (records) => {
        const graph = extractGraph(records);
        expect(() => designGraphSchema.parse(graph)).not.toThrow();
        const nodeIds = new Set(graph.nodes.map((n) => n.id));
        expect(nodeIds.size).toBe(graph.nodes.length);
        for (const edge of graph.edges) {
          expect(nodeIds.has(edge.from)).toBe(true);
          expect(nodeIds.has(edge.to)).toBe(true);
        }
        expect(new Set(graph.edges.map((e) => e.id)).size).toBe(graph.edges.length);
        // Every record is accounted for: a node, an arrow (edges or ignored), or ignored.
        const accounted =
          graph.nodes.length +
          new Set(graph.edges.map((e) => e.arrowId)).size +
          graph.ignored.length;
        expect(accounted).toBe(records.length);
      }),
      { numRuns: 500 },
    );
  });

  it("the rules never throw, and every finding points at shapes on the board", () => {
    fc.assert(
      fc.property(boardArb, fc.integer({ min: 0, max: 6 }), (records, maxSyncDepth) => {
        const { findings, ruleErrors, graph } = checkDesign(records, { maxSyncDepth });
        expect(ruleErrors).toEqual([]);
        const onBoard = new Set([
          ...graph.nodes.map((n) => n.id),
          ...graph.edges.map((e) => e.arrowId),
        ]);
        for (const finding of findings) {
          expect(() => findingSchema.parse(finding)).not.toThrow();
          for (const id of finding.shapeIds) expect(onBoard.has(id)).toBe(true);
        }
        expect(new Set(findings.map((f) => f.id)).size).toBe(findings.length);
      }),
      { numRuns: 500 },
    );
  });
});

describe("performance", () => {
  it("checks a 2,000-shape board quickly", () => {
    const builder = board();
    const count = 1500;
    for (let i = 0; i < count; i++) {
      const type = SYSTEM_SHAPE_TYPES[i % SYSTEM_SHAPE_TYPES.length] ?? "service";
      builder.add(type, `n${String(i)}`, { label: i % 7 === 0 ? "GET feed" : `node ${String(i)}` });
    }
    for (let i = 0; i < 500; i++) {
      builder.arrow(`n${String(i * 3)}`, `n${String((i * 7 + 1) % count)}`);
    }
    const shapes: Shape[] = builder.build();
    expect(shapes).toHaveLength(2000);

    checkDesign(shapes); // warm up
    const started = performance.now();
    const { ruleErrors } = checkDesign(shapes);
    const elapsed = performance.now() - started;
    expect(ruleErrors).toEqual([]);
    // Typically ~10 ms; the bound is generous so slow CI machines don't flake.
    expect(elapsed).toBeLessThan(250);
  });
});
