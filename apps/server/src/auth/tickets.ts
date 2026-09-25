import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import type { BoardRole } from "@whiteboard/shared/api";

export interface TicketClaims {
  userId: string | null;
  boardId: string;
  role: BoardRole;
  /** Share link the access came from, so revoking the link can find these sessions. */
  linkId: string | null;
  /** Access only because the board is public. */
  viaPublic: boolean;
}

const ISSUER = "whiteboard-server";
const AUDIENCE = "whiteboard-sync";
const TICKET_TTL_SECONDS = 5 * 60;

const payloadSchema = z.object({
  sub: z.string(),
  bid: z.uuid(),
  role: z.enum(["owner", "editor", "viewer"]),
  lid: z.uuid().nullable(),
  pub: z.boolean(),
});

/**
 * Short-lived (5 min) room tickets: HMAC-signed JWTs issued by the REST API after checking the
 * Supabase session and the board role, presented on the WebSocket upgrade.
 */
export class TicketIssuer {
  private readonly key: Uint8Array;

  constructor(secret: string) {
    this.key = new TextEncoder().encode(secret);
  }

  async issue(claims: TicketClaims): Promise<{ ticket: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + TICKET_TTL_SECONDS * 1000);
    const ticket = await new SignJWT({
      bid: claims.boardId,
      role: claims.role,
      lid: claims.linkId,
      pub: claims.viaPublic,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(claims.userId ?? "anonymous")
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .setJti(crypto.randomUUID())
      .sign(this.key);
    return { ticket, expiresAt };
  }

  /** Throws unless the ticket is authentic, unexpired and for `boardId`. */
  async verify(ticket: string, boardId: string): Promise<TicketClaims> {
    const { payload } = await jwtVerify(ticket, this.key, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["HS256"],
    });
    const claims = payloadSchema.parse(payload);
    if (claims.bid !== boardId) throw new Error("ticket is for a different board");
    return {
      userId: claims.sub === "anonymous" ? null : claims.sub,
      boardId: claims.bid,
      role: claims.role,
      linkId: claims.lid,
      viaPublic: claims.pub,
    };
  }
}
