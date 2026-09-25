// The eval's fixtures and grader (no model calls): the fixtures must be valid boards whose
// planted flaws point at real shapes, and the grader must only credit the right findings.
import { describe, expect, it } from "vitest";
import { aiReviewSchema, checkDesign, type ReviewFinding } from "@whiteboard/graph";
import { EVAL_CASES } from "../eval/fixtures";
import { catches, gradeCase } from "../eval/grade";

function finding(
  shapeIds: string[],
  text: string,
  severity: ReviewFinding["severity"] = "warning",
) {
  return {
    id: "f1",
    severity,
    dimension: "reliability" as const,
    title: text,
    explanation: "Explanation.",
    shapeIds,
    suggestion: "Suggestion.",
    ruleId: null,
  };
}

describe("eval fixtures", () => {
  it("has 15 uniquely named boards", () => {
    expect(EVAL_CASES).toHaveLength(15);
    expect(new Set(EVAL_CASES.map((c) => c.name)).size).toBe(15);
  });

  it.each(EVAL_CASES.map((c) => [c.name, c] as const))(
    "%s is a valid board and its flaws point at real shapes",
    (_name, testCase) => {
      const design = checkDesign(testCase.shapes);
      expect(design.graph.ignored).toEqual([]);
      const ids = new Set(testCase.shapes.map((s) => s.id));
      for (const flaw of testCase.flaws) {
        expect(flaw.shapes.length).toBeGreaterThan(0);
        for (const id of flaw.shapes) expect(ids.has(id), `${flaw.id}: ${id}`).toBe(true);
      }
    },
  );
});

describe("grader", () => {
  const spof = EVAL_CASES.find((c) => c.name === "db-single-point-of-failure");
  if (!spof) throw new Error("fixture missing");
  const flaw = spof.flaws[0];
  if (!flaw) throw new Error("flaw missing");

  it("credits a finding on the right shape, severity and topic", () => {
    expect(
      catches(finding(["db"], "Database is a single point of failure", "critical"), flaw),
    ).toBe(true);
  });

  it("rejects the wrong shape, a lower severity or an unrelated topic", () => {
    expect(catches(finding(["api1"], "Single point of failure", "critical"), flaw)).toBe(false);
    expect(catches(finding(["db"], "Single point of failure", "warning"), flaw)).toBe(false);
    expect(catches(finding(["db"], "Add indexes", "critical"), flaw)).toBe(false);
  });

  it("a board passes only when every planted flaw is caught", () => {
    const review = aiReviewSchema.parse({
      summary: "s",
      scores: { scalability: 5, reliability: 3, data_design: 5, security: 5, cost: 5 },
      findings: [finding(["db"], "No failover for the database", "critical")],
      followUpQuestions: [],
    });
    expect(gradeCase(spof, review)).toMatchObject({ passed: true, invalidReferences: 0 });
    expect(gradeCase(spof, { ...review, findings: [] }).passed).toBe(false);
    expect(gradeCase(spof, null).passed).toBe(false);
  });
});
