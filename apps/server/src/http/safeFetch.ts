/**
 * Outbound HTTP for the server, restricted to a fixed set of origins.
 *
 * The server never fetches a URL a user supplied (no link previews, image imports or
 * webhooks-to-customer URLs). This guard keeps it that way: every outbound call names the
 * services it may reach (Supabase, Razorpay), so a bug that lets user input into a URL (a
 * path segment with `@`, `//`, `..`) can't turn into a request to another host, a cloud
 * metadata endpoint or an internal service. Redirects are refused for the same reason: an
 * allowed host can't bounce us elsewhere. Anthropic calls go through its SDK (fixed base URL).
 */
export class BlockedFetchError extends Error {
  constructor(url: string) {
    // Only the origin: paths can carry ids and query strings can carry secrets.
    super(`outbound request to a host that is not allowlisted: ${safeOrigin(url)}`);
    this.name = "BlockedFetchError";
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

export function createSafeFetch(
  allowedOrigins: readonly string[],
  base: typeof fetch = fetch,
): typeof fetch {
  const allowed = new Set(allowedOrigins.map((origin) => new URL(origin).origin));
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return Promise.reject(new BlockedFetchError(url));
    }
    // Credentials in the authority (`https://api.razorpay.com@evil.test/`) are never ours.
    if (!allowed.has(parsed.origin) || parsed.username !== "" || parsed.password !== "")
      return Promise.reject(new BlockedFetchError(url));
    return base(parsed, {
      ...init,
      redirect: "error",
      signal: init?.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  };
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "(invalid URL)";
  }
}
