import type { IncomingMessage } from "node:http";

/**
 * The client's IP for rate limiting, trusting X-Forwarded-For from exactly `trustedHops`
 * proxies (Render's load balancer is one). Each trusted proxy appends the address it saw, so
 * the client is the entry `trustedHops` places from the right; anything further left was
 * written by the client and can be forged. Mirrors Fastify's `trustProxy` for REST routes.
 */
export function clientIp(request: IncomingMessage, trustedHops: number): string {
  const socketAddress = request.socket.remoteAddress ?? "unknown";
  if (trustedHops <= 0) return socketAddress;
  const header = request.headers["x-forwarded-for"];
  const forwarded = (Array.isArray(header) ? header.join(",") : (header ?? ""))
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const chain = [...forwarded, socketAddress];
  return chain[Math.max(0, chain.length - 1 - trustedHops)] ?? socketAddress;
}
