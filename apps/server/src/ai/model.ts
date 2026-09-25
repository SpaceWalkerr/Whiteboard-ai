import Anthropic from "@anthropic-ai/sdk";
import type { AiCallStatus } from "@whiteboard/shared/db";
import { NO_USAGE, type TokenUsage } from "./pricing";

/**
 * The one place the server talks to Claude. Everything else depends on the `LanguageModel`
 * interface, so tests use a fake and never call (or pay for) the real API.
 *
 * Calls are single-turn, with no tools: the model can only return JSON matching the given
 * schema, so nothing it says can act on a board (prompt-injection containment).
 */
export interface ModelRequest {
  model: string;
  /** Static instructions; cached (prompt caching) because they are identical on every call. */
  system: string;
  /** The per-request content (untrusted board data, wrapped by the caller). */
  user: string;
  maxTokens: number;
  /** JSON schema the answer must follow (structured outputs). */
  outputSchema: Record<string, unknown>;
  /** Adaptive thinking + effort (review model only; the hint model doesn't support them). */
  reasoning?: { effort: "low" | "medium" | "high" } | undefined;
  signal?: AbortSignal | undefined;
  /** Rough count of output tokens generated so far, for progress display. */
  onOutputProgress?: ((approxTokens: number) => void) | undefined;
}

export interface ModelResult {
  /** ok: `text` holds the JSON answer. refused / truncated: no usable answer. */
  status: Extract<AiCallStatus, "ok" | "refused" | "truncated">;
  text: string;
  usage: TokenUsage;
  requestId: string | null;
}

/** A call that failed (API error, network, timeout) or was aborted by the client. */
export class ModelCallError extends Error {
  constructor(
    readonly status: Extract<AiCallStatus, "error" | "aborted">,
    readonly usage: TokenUsage,
    readonly requestId: string | null,
    options?: ErrorOptions,
  ) {
    super(`model call ${status}`, options);
    this.name = "ModelCallError";
  }
}

export interface LanguageModel {
  generate(request: ModelRequest): Promise<ModelResult>;
}

function usageOf(message: Anthropic.Message | undefined): TokenUsage {
  if (!message) return NO_USAGE;
  const u = message.usage;
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
  };
}

/** Characters per token, roughly, for the progress indicator only (never for billing). */
const CHARS_PER_TOKEN = 4;

export class AnthropicModel implements LanguageModel {
  private readonly client: Anthropic;

  constructor(apiKey: string, options: { timeoutMs?: number } = {}) {
    this.client = new Anthropic({
      apiKey,
      // One retry for transient failures (429/5xx/connection) before the stream starts;
      // more would multiply the user's wait for a review.
      maxRetries: 1,
      timeout: options.timeoutMs ?? 180_000,
    });
  }

  async generate(request: ModelRequest): Promise<ModelResult> {
    const stream = this.client.messages.stream(
      {
        model: request.model,
        max_tokens: request.maxTokens,
        system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: request.user }],
        output_config: {
          format: { type: "json_schema", schema: request.outputSchema },
          ...(request.reasoning ? { effort: request.reasoning.effort } : {}),
        },
        ...(request.reasoning ? { thinking: { type: "adaptive" as const } } : {}),
      },
      { signal: request.signal },
    );

    let chars = 0;
    stream.on("streamEvent", (event) => {
      if (event.type !== "content_block_delta") return;
      const delta = event.delta;
      if (delta.type === "text_delta") chars += delta.text.length;
      else if (delta.type === "thinking_delta") chars += delta.thinking.length;
      else return;
      request.onOutputProgress?.(Math.round(chars / CHARS_PER_TOKEN));
    });

    let message: Anthropic.Message;
    try {
      message = await stream.finalMessage();
    } catch (error) {
      // Usage so far (input tokens from message_start, if it arrived) is still billed.
      const usage = usageOf(stream.currentMessage);
      const status = error instanceof Anthropic.APIUserAbortError ? "aborted" : "error";
      throw new ModelCallError(status, usage, stream.request_id ?? null, { cause: error });
    }

    const usage = usageOf(message);
    const requestId = stream.request_id ?? null;
    if (message.stop_reason === "refusal") return { status: "refused", text: "", usage, requestId };
    if (message.stop_reason === "max_tokens")
      return { status: "truncated", text: "", usage, requestId };
    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    return { status: "ok", text, usage, requestId };
  }
}
