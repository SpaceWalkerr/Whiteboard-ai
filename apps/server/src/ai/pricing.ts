/**
 * Claude API prices, in US dollars per million tokens (= micro-dollars per token), used to log
 * the cost of every call and enforce the daily spend kill-switch. Anthropic first-party
 * standard rates as of 2026-09; re-check https://www.anthropic.com/pricing before launch and
 * whenever a model changes. Cache writes use the 5-minute TTL (1.25× input); cache reads
 * cost 0.1× input.
 */
export const REVIEW_MODEL = "claude-sonnet-5";
export const HINT_MODEL = "claude-haiku-4-5-20251001";

interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

const PRICES: Record<string, ModelPrice> = {
  [REVIEW_MODEL]: { inputPerMTok: 2, outputPerMTok: 10 },
  [HINT_MODEL]: { inputPerMTok: 1, outputPerMTok: 5 },
};

const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

export interface TokenUsage {
  /** Uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export const NO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
};

export function isPricedModel(model: string): boolean {
  return model in PRICES;
}

/** Cost of one call in micro-dollars (1e-6 USD), rounded up so we never under-count spend. */
export function costUsdMicros(model: string, usage: TokenUsage): number {
  const price = PRICES[model];
  // Refuse to guess: an unpriced model would silently bypass the spend kill-switch.
  if (!price) throw new Error(`No price configured for model ${model}`);
  const input =
    usage.inputTokens * price.inputPerMTok +
    usage.cacheCreationTokens * price.inputPerMTok * CACHE_WRITE_MULTIPLIER +
    usage.cacheReadTokens * price.inputPerMTok * CACHE_READ_MULTIPLIER;
  return Math.ceil(input + usage.outputTokens * price.outputPerMTok);
}
