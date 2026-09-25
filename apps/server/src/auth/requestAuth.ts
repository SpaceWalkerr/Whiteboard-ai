import type { FastifyInstance, FastifyRequest } from "fastify";
import { UnauthorizedError } from "../errors";
import type { AuthUser, TokenVerifier } from "./verifier";

declare module "fastify" {
  interface FastifyRequest {
    /** The verified Supabase user, or null for requests without a bearer token. */
    user: AuthUser | null;
  }
}

/**
 * Verifies `Authorization: Bearer <Supabase access token>` on every request. A missing header
 * leaves `request.user` null (routes decide); a present but invalid token is always a 401.
 */
export function registerRequestAuth(app: FastifyInstance, verifier: TokenVerifier): void {
  app.decorateRequest("user", null);
  app.addHook("onRequest", async (request) => {
    const header = request.headers.authorization;
    if (header === undefined) return;
    if (!header.startsWith("Bearer ")) throw new UnauthorizedError();
    try {
      request.user = await verifier.verify(header.slice("Bearer ".length));
    } catch {
      throw new UnauthorizedError("Your session has expired. Please sign in again.");
    }
  });
}

export function requireUser(request: FastifyRequest): AuthUser {
  if (!request.user) throw new UnauthorizedError();
  return request.user;
}
