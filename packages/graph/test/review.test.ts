import { describe, expect, it } from "vitest";
import {
  aiReviewSchema,
  diffReviews,
  extractGraph,
  graphFingerprint,
  overallScore,
  reviewRequestSchema,
  type AiReview,
  type ReviewFinding,
} from "../src";
import { board } from "./fixtures/board";

function finding(id: string, shapeIds: string[], overrides: Partial<ReviewFinding> = {}) {
  return {
    id,
    severity: "warning" as const,
    dimension: "reliability" as const,
    title: `Finding ${id}`,
    explanation: "Because.",
    shapeIds,
    suggestion: "Fix it.",
    ruleId: null,
    ...overrides,
  };
}

function review(findings: ReviewFinding[], scalability = 5): AiReview {
  return aiReviewSchema.parse({
    summary: "Summary.",
    scores: { scalability, reliability: 5, data_design: 5, security: 5, cost: 5 },
    findings,
    followUpQuestions: [],
  });
}

describe("diffReviews", () => {
  it("matches findings about the same shapes and dimension, reworded or reordered", () => {
    const before = review([
      finding("f1", ["db"], { title: "Database is a SPOF" }),
      finding("f2", ["api", "lb"], { dimension: "scalability" }),
      finding("f3", ["cdn"], { dimension: "cost" }),
    ]);
    const after = review(
      [
        finding("f1", ["api"], { dimension: "scalability", title: "Only one API node" }),
        finding("f2", ["db", "a2"], { title: "No database failover" }),
        finding("f3", ["queue"], { dimension: "reliability" }),
      ],
      7,
    );
    const diff = diffReviews(before, after);
    expect([...diff.changes]).toEqual([
      ["f1", "persisting"],
      ["f2", "persisting"],
      ["f3", "new"],
    ]);
    expect(diff.resolved.map((f) => f.id)).toEqual(["f3"]);
    expect(diff.scoreDeltas).toEqual({
      scalability: 2,
      reliability: 0,
      data_design: 0,
      security: 0,
      cost: 0,
    });
  });

  it("a different dimension on the same shapes is a different finding, unless the rule matches", () => {
    const before = review([finding("f1", ["db"], { dimension: "security", ruleId: "x" })]);
    expect(diffReviews(before, review([finding("f1", ["db"])])).resolved).toHaveLength(1);
    const sameRule = review([finding("f1", ["db"], { ruleId: "x" })]);
    expect(diffReviews(before, sameRule).resolved).toHaveLength(0);
  });

  it("matches each older finding at most once", () => {
    const before = review([finding("f1", ["db"])]);
    const after = review([finding("f1", ["db"]), finding("f2", ["db"])]);
    expect([...diffReviews(before, after).changes.values()]).toEqual(["persisting", "new"]);
  });
});

describe("graphFingerprint", () => {
  const base = () =>
    board()
      .add("service", "api", { label: "API" })
      .add("database", "db", { label: "DB" })
      .arrow("api", "db", { id: "a1" });

  it("ignores moves, styling and label case", () => {
    const shapes = base().build();
    const moved = shapes.map((s) => ({
      ...s,
      x: s.x + 50,
      style: { ...s.style, fill: "#ff0000" },
    }));
    const renamed = shapes.map((s) => (s.id === "api" ? { ...s, label: "api " } : s));
    const fp = graphFingerprint(extractGraph(shapes));
    expect(graphFingerprint(extractGraph(moved))).toBe(fp);
    expect(graphFingerprint(extractGraph(renamed))).toBe(fp);
  });

  it("changes when components, connections or their meaning change", () => {
    const fp = graphFingerprint(extractGraph(base().build()));
    expect(graphFingerprint(extractGraph(base().add("cache", "c").build()))).not.toBe(fp);
    expect(
      graphFingerprint(extractGraph(base().arrow("db", "api", { type: "async" }).build())),
    ).not.toBe(fp);
    const replica = base()
      .build()
      .map((s) => (s.type === "database" ? { ...s, role: "replica" as const } : s));
    expect(graphFingerprint(extractGraph(replica))).not.toBe(fp);
  });
});

describe("review contract", () => {
  it("averages scores to one decimal", () => {
    expect(
      overallScore({ scalability: 7, reliability: 4, data_design: 8, security: 9, cost: 6 }),
    ).toBe(6.8);
  });

  it("trims and bounds the review request", () => {
    expect(reviewRequestSchema.parse({})).toEqual({ problemStatement: "", requirements: "" });
    expect(
      reviewRequestSchema.parse({ problemStatement: "  URL shortener " }).problemStatement,
    ).toBe("URL shortener");
    expect(reviewRequestSchema.safeParse({ requirements: "x".repeat(2001) }).success).toBe(false);
  });
});
