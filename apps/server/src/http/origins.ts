export interface OriginPolicy {
  allowedOrigins: readonly string[];
  allowedOriginPattern?: RegExp | undefined;
}

/**
 * Exact-match allowlist plus an optional anchored pattern (Vercel previews). Shared by CORS
 * and the WebSocket upgrade check so both entry points enforce the same rule.
 */
export function createOriginMatcher(policy: OriginPolicy): (origin: string) => boolean {
  const exact = new Set(policy.allowedOrigins);
  return (origin) => exact.has(origin) || (policy.allowedOriginPattern?.test(origin) ?? false);
}
