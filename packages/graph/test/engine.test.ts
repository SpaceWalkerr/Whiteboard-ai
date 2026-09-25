import { describe, expect, it } from "vitest";
import {
  checkDesign,
  DEFAULT_RULES,
  findingSchema,
  makeFinding,
  runRules,
  extractGraph,
  type Rule,
} from "../src";
import { board } from "./fixtures/board";

function chain(length: number) {
  const builder = board();
  const ids = Array.from({ length }, (_, i) => `s${String(i)}`);
  for (const id of ids) builder.add("service", id);
  return builder.chain(...ids).build();
}

describe("rules engine", () => {
  it("sorts by severity, then rule order, then board position", () => {
    const shapes = board()
      .add("cache", "orphan")
      .add("queue", "q")
      .add("database", "db2")
      .add("client", "app")
      .add("database", "db1")
      .arrow("app", "db1")
      .arrow("app", "q", { type: "async" })
      .arrow("app", "db2")
      .build();
    const { findings } = checkDesign(shapes);
    expect(findings.map((f) => `${f.severity}/${f.ruleId}/${f.shapeIds[0] ?? ""}`)).toEqual([
      "critical/db-spof/db2",
      "critical/db-spof/db1",
      "critical/client-direct-db/app",
      "critical/client-direct-db/app",
      "warning/queue-no-dlq/q",
      "info/disconnected/orphan",
    ]);
    for (const finding of findings) expect(findingSchema.parse(finding)).toEqual(finding);
  });

  it("gives the same problem the same finding id on every run", () => {
    const shapes = board().add("database", "db").build();
    expect(checkDesign(shapes).findings[0]?.id).toBe("db-spof:db");
    expect(checkDesign(shapes).findings[0]?.id).toBe(checkDesign(shapes).findings[0]?.id);
  });

  it("isolates a rule that throws", () => {
    const broken: Rule = {
      id: "broken",
      description: "always throws",
      check: () => {
        throw new Error("boom");
      },
    };
    const result = runRules(extractGraph(board().add("database", "db").build()), {
      rules: [broken, ...DEFAULT_RULES],
    });
    expect(result.ruleErrors).toEqual([{ ruleId: "broken", message: "boom" }]);
    expect(result.findings.map((f) => f.ruleId)).toEqual(["db-spof"]);
  });

  it("merges duplicate findings from one rule", () => {
    const twice: Rule = {
      id: "twice",
      description: "reports the same thing twice",
      check: () => {
        const text = { title: "t", explanation: "e", suggestion: "s" };
        return [
          makeFinding("twice", "info", ["a", "b"], text),
          makeFinding("twice", "info", ["b", "a", "a"], text),
        ];
      },
    };
    const { findings } = runRules(extractGraph([]), { rules: [twice] });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.shapeIds).toEqual(["b", "a"]);
  });

  it("uses maxSyncDepth (default 3)", () => {
    const five = chain(5); // 4 hops
    expect(checkDesign(five).findings.map((f) => f.ruleId)).toContain("deep-sync-chain");
    expect(checkDesign(five, { maxSyncDepth: 4 }).findings.map((f) => f.ruleId)).not.toContain(
      "deep-sync-chain",
    );
    expect(checkDesign(chain(4)).findings.map((f) => f.ruleId)).not.toContain("deep-sync-chain");
  });

  it("measures chains through cycles without looping forever", () => {
    const shapes = board()
      .add("service", "a")
      .add("service", "b")
      .add("service", "c")
      .add("service", "d")
      .add("service", "e")
      .chain("a", "b", "c", "d", "e")
      .arrow("e", "a")
      .build();
    const ruleIds = checkDesign(shapes).findings.map((f) => f.ruleId);
    expect(ruleIds).toContain("sync-cycle");
    // The whole chain is one cycle: one step in the condensation, not a deep chain.
    expect(ruleIds).not.toContain("deep-sync-chain");
  });
});

describe("acceptance", () => {
  it("a single database with no replica is a critical SPOF on that database; adding a replica fixes it", () => {
    const design = board()
      .add("client", "app", { label: "Web app" })
      .add("service", "api", { label: "API" })
      .add("database", "db", { label: "Postgres" })
      .chain("app", "api", "db");

    const before = checkDesign(design.build()).findings.filter((f) => f.ruleId === "db-spof");
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ severity: "critical", shapeIds: ["db"] });

    design
      .add("database", "replica", { label: "Postgres replica", role: "replica" })
      .arrow("db", "replica", { type: "replication" });
    const after = checkDesign(design.build()).findings;
    expect(after.filter((f) => f.ruleId === "db-spof")).toEqual([]);
  });
});
