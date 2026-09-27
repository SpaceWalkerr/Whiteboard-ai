import { describe, expect, it } from "vitest";
import { BOARD_TEMPLATES } from "@whiteboard/shared/templates";
import { checkDesign } from "../src";

// Templates are sold as "good starting designs": the rules engine must not flag them.
describe("public templates pass the design check", () => {
  it.each(BOARD_TEMPLATES.map((t) => [t.slug, t] as const))("%s", (_slug, template) => {
    const result = checkDesign(template.shapes);
    expect(result.ruleErrors).toEqual([]);
    const serious = result.findings.filter((f) => f.severity !== "info");
    expect(serious.map((f) => f.title)).toEqual([]);
    // Every component and arrow made it into the graph.
    const arrows = template.shapes.filter((s) => s.type === "arrow").length;
    expect(result.graph.edges).toHaveLength(arrows);
  });
});
