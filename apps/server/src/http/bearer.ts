import { timingSafeEqual } from "node:crypto";

/**
 * Checks an `Authorization: Bearer <token>` header against a secret in constant time, so the
 * secret can't be guessed byte by byte from response timings.
 */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const provided = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
