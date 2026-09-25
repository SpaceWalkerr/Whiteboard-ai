import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";

export interface AuthUser {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

export interface TokenVerifier {
  /** Verifies a Supabase access token; throws if it is invalid, expired or not a user session. */
  verify(token: string): Promise<AuthUser>;
}

/** The project's public signing keys, fetched and cached (handles key rotation). */
export function supabaseJwks(supabaseUrl: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`), {
    cacheMaxAge: 10 * 60 * 1000,
    cooldownDuration: 30_000,
  });
}

const claimsSchema = z.object({
  sub: z.uuid(),
  role: z.literal("authenticated"),
  email: z.string().optional(),
  is_anonymous: z.boolean().optional(),
  user_metadata: z
    .object({
      full_name: z.string().optional(),
      name: z.string().optional(),
      avatar_url: z.string().optional(),
    })
    .loose()
    .optional(),
});

/**
 * Verifies Supabase access tokens with the project's asymmetric keys (JWKS): signature,
 * issuer, audience and expiry. The user id always comes from the verified token — never from
 * a request body.
 */
export function createTokenVerifier(options: {
  issuer: string;
  keys: JWTVerifyGetKey;
}): TokenVerifier {
  return {
    async verify(token) {
      const { payload } = await jwtVerify(token, options.keys, {
        issuer: options.issuer,
        audience: "authenticated",
        algorithms: ["ES256", "RS256", "EdDSA"],
        clockTolerance: 5,
      });
      const claims = claimsSchema.parse(payload);
      if (claims.is_anonymous) throw new Error("anonymous sessions are not supported");
      const meta = claims.user_metadata;
      return {
        id: claims.sub,
        email: claims.email ? claims.email.toLowerCase() : null,
        name: meta?.full_name ?? meta?.name ?? null,
        avatarUrl: meta?.avatar_url ?? null,
      };
    },
  };
}
