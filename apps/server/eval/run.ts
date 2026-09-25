// AI review eval: runs the real review pipeline (same prompt, model, repair) on the fixture
// boards and reports which planted flaws were caught. Calls the Claude API and costs money
// (roughly $0.05–0.15 per board). Re-run whenever the prompt, model or effort changes.
//
//   pnpm --filter @whiteboard/server eval:review [--only <name>] [--concurrency 3] [--effort high]
//
// Needs ANTHROPIC_API_KEY (apps/server/.env). Exits 1 if fewer than PASS_THRESHOLD boards pass.
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { checkDesign, type AiReview } from "@whiteboard/graph";
import { AnthropicModel } from "../src/ai/model";
import { costUsdMicros, REVIEW_MODEL } from "../src/ai/pricing";
import { REVIEW_PROMPT_VERSION } from "../src/ai/prompts";
import { runReview, type ReviewSettings } from "../src/ai/reviewer";
import { EVAL_CASES, type EvalCase } from "./fixtures";
import { gradeCase, type CaseResult } from "./grade";

const PASS_THRESHOLD = 12;

const { values } = parseArgs({
  options: {
    only: { type: "string" },
    concurrency: { type: "string", default: "3" },
    effort: { type: "string", default: process.env.AI_REVIEW_EFFORT ?? "high" },
    "max-tokens": { type: "string", default: process.env.AI_REVIEW_MAX_TOKENS ?? "16000" },
  },
});

const effort = values.effort;
if (effort !== "low" && effort !== "medium" && effort !== "high")
  throw new Error("--effort must be low, medium or high");
const settings: ReviewSettings = {
  model: REVIEW_MODEL,
  maxTokens: Number(values["max-tokens"]),
  effort,
};

interface Run {
  testCase: EvalCase;
  result: CaseResult;
  status: string;
  costMicros: number;
  latencyMs: number;
  usage: unknown;
  review: AiReview | null;
}

async function runCase(model: AnthropicModel, testCase: EvalCase): Promise<Run> {
  const design = checkDesign(testCase.shapes);
  const outcome = await runReview(model, settings, {
    graph: design.graph,
    ruleFindings: design.findings,
    problemStatement: testCase.problemStatement,
    requirements: testCase.requirements,
  });
  return {
    testCase,
    result: gradeCase(testCase, outcome.review),
    status: outcome.status,
    costMicros: costUsdMicros(outcome.model, outcome.usage),
    latencyMs: outcome.latencyMs,
    usage: outcome.usage,
    review: outcome.review,
  };
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      const item = items[i];
      if (item !== undefined) results[i] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set (apps/server/.env)");
  const cases = values.only ? EVAL_CASES.filter((c) => c.name === values.only) : EVAL_CASES;
  if (cases.length === 0) throw new Error(`no eval case named ${values.only ?? ""}`);

  const model = new AnthropicModel(apiKey);
  process.stdout.write(
    `Reviewing ${String(cases.length)} boards with ${settings.model} (effort ${settings.effort}, prompt v${String(REVIEW_PROMPT_VERSION)})…\n\n`,
  );
  const runs = await mapLimit(cases, Number(values.concurrency), async (testCase) => {
    const run = await runCase(model, testCase);
    const mark = run.result.passed ? "PASS" : "FAIL";
    const flaws = run.result.flaws
      .map((f) => `${f.caught ? "✓" : "✗"} ${f.id}${f.by ? ` (${f.by})` : ""}`)
      .join(", ");
    process.stdout.write(
      `${mark}  ${testCase.name.padEnd(42)} ${flaws}  [${run.status}, ${String(run.result.findingCount)} findings, $${(run.costMicros / 1e6).toFixed(3)}, ${(run.latencyMs / 1000).toFixed(1)} s]\n`,
    );
    return run;
  });

  const passed = runs.filter((r) => r.result.passed).length;
  const flawsTotal = runs.reduce((n, r) => n + r.result.flaws.length, 0);
  const flawsCaught = runs.reduce((n, r) => n + r.result.flaws.filter((f) => f.caught).length, 0);
  const cost = runs.reduce((n, r) => n + r.costMicros, 0);
  const invalid = runs.reduce((n, r) => n + r.result.invalidReferences, 0);
  process.stdout.write(
    `\n${String(passed)}/${String(runs.length)} boards passed (threshold ${String(PASS_THRESHOLD)}), ${String(flawsCaught)}/${String(flawsTotal)} flaws caught, ${String(invalid)} findings with unknown shapes, total cost $${(cost / 1e6).toFixed(3)}\n`,
  );

  const dir = fileURLToPath(new URL("./results/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  const file = `${dir}${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(
    file,
    JSON.stringify(
      {
        settings,
        promptVersion: REVIEW_PROMPT_VERSION,
        passed,
        total: runs.length,
        flawsCaught,
        flawsTotal,
        costUsd: cost / 1e6,
        runs: runs.map((r) => ({
          name: r.testCase.name,
          status: r.status,
          result: r.result,
          usage: r.usage,
          costUsd: r.costMicros / 1e6,
          latencyMs: r.latencyMs,
          review: r.review,
        })),
      },
      null,
      2,
    ),
  );
  process.stdout.write(`Full results: ${file}\n`);
  if (!values.only && passed < PASS_THRESHOLD) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
