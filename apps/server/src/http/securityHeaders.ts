/**
 * Headers on every API response. The API only ever returns JSON (and server-sent events), so
 * nothing it serves should be rendered, framed or sniffed by a browser:
 * - CSP `default-src 'none'`: if a response were ever opened as a page, nothing in it runs.
 * - `no-store` unless a route chose its own caching: responses carry private board and billing
 *   data, which must never sit in a shared or on-disk cache.
 * HSTS is set here too for when the API is opened directly (browsers ignore it over http).
 */
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};
