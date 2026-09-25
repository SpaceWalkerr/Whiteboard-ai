import * as Y from "yjs";
import type { Shape } from "@whiteboard/shared/board";
import type { AiConfig } from "../src/api/deps";
import {
  ModelCallError,
  type LanguageModel,
  type ModelRequest,
  type ModelResult,
} from "../src/ai/model";
import { HINT_MODEL, REVIEW_MODEL, type TokenUsage } from "../src/ai/pricing";
import type { BoardRepository } from "../src/persistence/repository";

export const FAKE_USAGE: TokenUsage = {
  inputTokens: 1200,
  outputTokens: 800,
  cacheCreationTokens: 0,
  cacheReadTokens: 1500,
};

type Responder = (request: ModelRequest) => ModelResult | Promise<ModelResult>;

/** Stands in for Claude: records every request and answers with whatever the test says. */
export class FakeModel implements LanguageModel {
  readonly calls: ModelRequest[] = [];
  respond: Responder = () => okJson(minimalReview());

  async generate(request: ModelRequest): Promise<ModelResult> {
    this.calls.push(request);
    return this.respond(request);
  }
}

export function okJson(value: unknown, usage: TokenUsage = FAKE_USAGE): ModelResult {
  return { status: "ok", text: JSON.stringify(value), usage, requestId: "req_fake" };
}

export function modelError(status: "error" | "aborted" = "error"): never {
  throw new ModelCallError(status, { ...FAKE_USAGE, outputTokens: 0 }, "req_fake");
}

export function minimalReview(findings: unknown[] = []) {
  return {
    summary: "Solid start. Add a replica for the database first.",
    scores: { scalability: 6, reliability: 4, data_design: 7, security: 8, cost: 7 },
    findings,
    follow_up_questions: ["What happens when the database fails over?"],
  };
}

export function finding(refs: string[], overrides: Record<string, unknown> = {}) {
  return {
    severity: "critical",
    dimension: "reliability",
    title: "Single database",
    explanation: "Every request depends on one database instance.",
    refs,
    suggestion: "Add a replica with automatic failover.",
    rule: null,
    ...overrides,
  };
}

export function fakeAiConfig(model: LanguageModel | undefined, overrides: Partial<AiConfig> = {}) {
  return {
    model,
    enabled: true,
    // Far above anything the tests spend; the dev database holds other runs' usage too.
    dailySpendLimitUsd: 1_000_000,
    review: { model: REVIEW_MODEL, maxTokens: 4000, effort: "medium" as const },
    hints: { model: HINT_MODEL, maxTokens: 500, perHour: 20 },
    maxElements: 600,
    ...overrides,
  } satisfies AiConfig;
}

/** Stores shapes on a board the way the sync server does (one Yjs update). */
export async function writeShapes(
  repository: BoardRepository,
  boardId: string,
  shapes: readonly Shape[],
): Promise<void> {
  const doc = new Y.Doc();
  const map = doc.getMap<unknown>("shapes");
  doc.transact(() => {
    for (const shape of shapes) map.set(shape.id, shape);
  });
  await repository.append(boardId, [
    { update: Y.encodeStateAsUpdate(doc), clientId: null, userId: null },
  ]);
  doc.destroy();
}

/** Reads a server-sent event stream to the end and returns the parsed events. */
export async function readEvents(response: Response): Promise<unknown[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length))
        .join("\n"),
    )
    .filter((data) => data.length > 0)
    .map((data) => JSON.parse(data) as unknown);
}
