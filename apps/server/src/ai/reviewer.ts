import type { AiReview, DesignGraph, Finding, Hint } from "@whiteboard/graph";
import type { AiCallStatus } from "@whiteboard/shared/db";
import { buildBoardData } from "./boardData";
import { ModelCallError, type LanguageModel } from "./model";
import { NO_USAGE, type TokenUsage } from "./pricing";
import {
  HINT_OUTPUT_SCHEMA,
  HINT_SYSTEM_PROMPT,
  hintUserMessage,
  REVIEW_OUTPUT_SCHEMA,
  REVIEW_SYSTEM_PROMPT,
  reviewUserMessage,
} from "./prompts";
import { InvalidModelOutputError, repairHints, repairReview, type RepairStats } from "./repair";

/**
 * The review and hint pipelines without any I/O besides the model call: build the data
 * block, call Claude, validate and repair. Used by the API routes (which add auth, quotas,
 * persistence and usage logging) and by the eval script.
 */

export interface CallOutcome {
  status: AiCallStatus;
  usage: TokenUsage;
  requestId: string | null;
  latencyMs: number;
  model: string;
  stats: RepairStats | null;
  /** Internal detail for logs (never shown to users). */
  error?: unknown;
}

export interface ReviewSettings {
  model: string;
  maxTokens: number;
  effort: "low" | "medium" | "high";
}

export interface ReviewInput {
  graph: DesignGraph;
  ruleFindings: readonly Finding[];
  problemStatement: string;
  requirements: string;
  signal?: AbortSignal | undefined;
  onOutputProgress?: ((approxTokens: number) => void) | undefined;
}

async function call<T>(
  model: string,
  run: () => Promise<{
    status: AiCallStatus;
    usage: TokenUsage;
    requestId: string | null;
    text: string;
  }>,
  repair: (text: string) => { value: T; stats: RepairStats },
): Promise<CallOutcome & { value: T | null }> {
  const started = performance.now();
  const latency = () => Math.round(performance.now() - started);
  try {
    const result = await run();
    if (result.status !== "ok")
      return { ...result, latencyMs: latency(), model, stats: null, value: null };
    try {
      const { value, stats } = repair(result.text);
      return { ...result, latencyMs: latency(), model, stats, value };
    } catch (error) {
      if (!(error instanceof InvalidModelOutputError)) throw error;
      return {
        status: "invalid_output",
        usage: result.usage,
        requestId: result.requestId,
        latencyMs: latency(),
        model,
        stats: null,
        value: null,
        error,
      };
    }
  } catch (error) {
    if (error instanceof ModelCallError)
      return {
        status: error.status,
        usage: error.usage,
        requestId: error.requestId,
        latencyMs: latency(),
        model,
        stats: null,
        value: null,
        error: error.cause ?? error,
      };
    return {
      status: "error",
      usage: NO_USAGE,
      requestId: null,
      latencyMs: latency(),
      model,
      stats: null,
      value: null,
      error,
    };
  }
}

export async function runReview(
  llm: LanguageModel,
  settings: ReviewSettings,
  input: ReviewInput,
): Promise<CallOutcome & { review: AiReview | null }> {
  const data = buildBoardData(input.graph, input.ruleFindings, input);
  const outcome = await call(
    settings.model,
    () =>
      llm.generate({
        model: settings.model,
        system: REVIEW_SYSTEM_PROMPT,
        user: reviewUserMessage(data.json),
        maxTokens: settings.maxTokens,
        outputSchema: REVIEW_OUTPUT_SCHEMA,
        reasoning: { effort: settings.effort },
        signal: input.signal,
        onOutputProgress: input.onOutputProgress,
      }),
    (text) => {
      const { review, stats } = repairReview(text, data.refs);
      return { value: review, stats };
    },
  );
  const { value, ...rest } = outcome;
  return { ...rest, review: value };
}

export interface HintSettings {
  model: string;
  maxTokens: number;
}

export async function runHints(
  llm: LanguageModel,
  settings: HintSettings,
  input: { graph: DesignGraph; ruleFindings: readonly Finding[]; signal?: AbortSignal },
): Promise<CallOutcome & { hints: Hint[] | null }> {
  const data = buildBoardData(input.graph, input.ruleFindings, {
    problemStatement: "",
    requirements: "",
  });
  const outcome = await call(
    settings.model,
    () =>
      llm.generate({
        model: settings.model,
        system: HINT_SYSTEM_PROMPT,
        user: hintUserMessage(data.json),
        maxTokens: settings.maxTokens,
        outputSchema: HINT_OUTPUT_SCHEMA,
        signal: input.signal,
      }),
    (text) => {
      const { hints, stats } = repairHints(text, data.refs);
      return { value: hints, stats };
    },
  );
  const { value, ...rest } = outcome;
  return { ...rest, hints: value };
}
