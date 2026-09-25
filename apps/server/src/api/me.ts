import type { FastifyInstance } from "fastify";
import type { BootstrapResponse } from "@whiteboard/shared/api";
import { and, boardMembers, boards, eq, invites, profiles, sql } from "@whiteboard/shared/db";
import { higherRole } from "../access/boardAccess";
import { audit } from "../audit/audit";
import { requireUser } from "../auth/requestAuth";
import type { ApiDeps } from "./deps";
import { ensureWorkspace } from "./workspace";

export function registerMeRoutes(app: FastifyInstance, deps: ApiDeps): void {
  /**
   * Called by the web app after every sign-in. Idempotent: ensures the profile and personal
   * workspace exist, and accepts pending invites sent to this (verified) email address.
   */
  app.post(
    "/me/bootstrap",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request): Promise<BootstrapResponse> => {
      const user = requireUser(request);
      return deps.db.transaction(async (tx) => {
        const personalOrgId = await ensureWorkspace(tx, user);

        let acceptedInvites = 0;
        if (user.email) {
          const pending = await tx
            .select({
              id: invites.id,
              boardId: invites.boardId,
              role: invites.role,
              orgId: boards.orgId,
            })
            .from(invites)
            .innerJoin(boards, eq(boards.id, invites.boardId))
            .where(
              and(
                eq(invites.email, user.email),
                sql`${invites.acceptedAt} is null and ${invites.revokedAt} is null and ${invites.expiresAt} > now()`,
                sql`${boards.deletedAt} is null`,
              ),
            );
          for (const invite of pending) {
            await addMember(tx, {
              boardId: invite.boardId,
              userId: user.id,
              role: invite.role,
              addedBy: null,
            });
            await tx
              .update(invites)
              .set({ acceptedAt: sql`now()`, acceptedBy: user.id })
              .where(eq(invites.id, invite.id));
            await audit(tx, {
              action: "invite.accept",
              actorId: user.id,
              orgId: invite.orgId,
              boardId: invite.boardId,
              targetType: "invite",
              targetId: invite.id,
              metadata: { role: invite.role, via: "sign-in" },
              ip: request.ip,
            });
            acceptedInvites += 1;
          }
        }

        const [profile] = await tx
          .select({
            id: profiles.id,
            email: profiles.email,
            displayName: profiles.displayName,
            avatarUrl: profiles.avatarUrl,
          })
          .from(profiles)
          .where(eq(profiles.id, user.id));
        if (!profile) throw new Error("profile missing after upsert");
        return {
          profile: { ...profile, displayName: profile.displayName ?? "Whiteboard user" },
          personalOrgId,
          acceptedInvites,
        };
      });
    },
  );
}

/** Adds a board member, keeping the higher role if they are already one. */
export async function addMember(
  tx: Parameters<Parameters<ApiDeps["db"]["transaction"]>[0]>[0],
  member: {
    boardId: string;
    userId: string;
    role: "owner" | "editor" | "viewer";
    addedBy: string | null;
  },
): Promise<"owner" | "editor" | "viewer"> {
  const [existing] = await tx
    .select({ role: boardMembers.role })
    .from(boardMembers)
    .where(and(eq(boardMembers.boardId, member.boardId), eq(boardMembers.userId, member.userId)));
  const role = higherRole(existing?.role ?? null, member.role) ?? member.role;
  if (existing) {
    if (existing.role !== role) {
      await tx
        .update(boardMembers)
        .set({ role })
        .where(
          and(eq(boardMembers.boardId, member.boardId), eq(boardMembers.userId, member.userId)),
        );
    }
  } else {
    await tx.insert(boardMembers).values(member);
  }
  return role;
}
