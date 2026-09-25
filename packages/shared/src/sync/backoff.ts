export interface BackoffOptions {
  initialMs: number;
  maxMs: number;
}

/**
 * Exponential backoff with "equal jitter": half the delay is fixed, half random, so a fleet
 * of clients reconnecting after a server restart doesn't arrive all at once.
 */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(options.maxMs, options.initialMs * 2 ** Math.max(0, attempt));
  return exponential / 2 + random() * (exponential / 2);
}
