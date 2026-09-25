import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, checkDesign } from "../src";
import { healthyBoard, RULE_FIXTURES } from "./fixtures/rules";

function ruleById(id: string) {
  const rule = DEFAULT_RULES.find((candidate) => candidate.id === id);
  if (!rule) throw new Error(`No rule ${id}`);
  return rule;
}

describe("rules", () => {
  it("every rule has at least one positive and one negative fixture", () => {
    for (const rule of DEFAULT_RULES) {
      const cases = RULE_FIXTURES.filter((fixture) => fixture.ruleId === rule.id);
      expect(
        cases.some((c) => c.expected.length > 0),
        `${rule.id} positive`,
      ).toBe(true);
      expect(
        cases.some((c) => c.expected.length === 0),
        `${rule.id} negative`,
      ).toBe(true);
    }
  });

  it.each(RULE_FIXTURES.map((fixture) => [`${fixture.ruleId}: ${fixture.name}`, fixture] as const))(
    "%s",
    (_name, fixture) => {
      const { findings, ruleErrors } = checkDesign(fixture.shapes, {
        rules: [ruleById(fixture.ruleId)],
      });
      expect(ruleErrors).toEqual([]);
      expect(
        findings.map((finding) => ({
          severity: finding.severity,
          shapeIds: [...finding.shapeIds].sort(),
        })),
      ).toEqual(
        fixture.expected.map((expected) => ({
          severity: expected.severity,
          shapeIds: [...expected.shapeIds].sort(),
        })),
      );
      for (const finding of findings) {
        expect(finding.ruleId).toBe(fixture.ruleId);
        expect(finding.title.length).toBeGreaterThan(0);
        expect(finding.explanation.length).toBeGreaterThan(0);
        expect(finding.suggestion.length).toBeGreaterThan(0);
      }
    },
  );

  it("a reasonable design produces no findings from any rule", () => {
    const { findings, ruleErrors, graph } = checkDesign(healthyBoard());
    expect(ruleErrors).toEqual([]);
    expect(graph.ignored).toEqual([]);
    expect(findings).toEqual([]);
  });
});
