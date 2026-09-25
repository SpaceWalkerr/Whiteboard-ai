import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  acceptInviteSchema,
  createShareLinkSchema,
  inviteRequestSchema,
  resolveShareLinkSchema,
  sharingSettingsSchema,
  updateMemberSchema,
  type CreatedShareLink,
  type SharingState,
} from "@whiteboard/shared/api";
import {
  and,
  boardMembers,
  boards,
  eq,
  invites,
  profiles,
  shareLinks,
  sql,
} from "@whiteboard/shared/db";
import { can, hashToken } from "../access/boardAccess";
import { audit } from "../audit/audit";
import { requireUser } from "../auth/requestAuth";
import { inviteEmail } from "../email/InviteEmail";
import { AppError, BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../errors";
import { authorize } from "./boards";
import type { ApiDeps } from "./deps";
import { addMember } from "./me";
import { newSecretToken } from "./tokens";
import { parse } from "./validation";
import { displayNameFor } from "./workspace";

const idParams = z.object({ id: z.uuid() });
const memberParams = z.object({ id: z.uuid(), userId: z.uuid() });
const linkParams = z.object({ id: z.uuid(), linkId: z.uuid() });
const inviteParams = z.object({ id: z.uuid(), inviteId: z.uuid() });
const INVITE_TTL_DAYS = 14;

export function registerSharingRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get("/boards/:id/sharing", async (request): Promise<SharingState> => {
    const user = requireUser(request);
    const { id } = parse(idParams, request.params);
    const access = await authorize(deps, id, user.id, "read");
    const members = await deps.db
      .select({
        userId: boardMembers.userId,
        role: boardMembers.role,
        email: profiles.email,
        displayName: profiles.displayName,
        avatarUrl: profiles.avatarUrl,
      })
      .from(boardMembers)
      .leftJoin(profiles, eq(profiles.id, boardMembers.userId))
      .where(eq(boardMembers.boardId, id))
      .orderBy(boardMembers.createdAt);
    // Pending invites and share links are only visible to people who can manage sharing.
    const manager = can(access.role, "share");
    const pending = manager
      ? await deps.db
          .select({
            id: invites.id,
            email: invites.email,
            role: invites.role,
            expiresAt: invites.expiresAt,
          })
          .from(invites)
          .where(
            and(
              eq(invites.boardId, id),
              sql`${invites.acceptedAt} is null and ${invites.revokedAt} is null and ${invites.expiresAt} > now()`,
            ),
          )
      : [];
    const links = manager
      ? await deps.db
          .select({
            id: shareLinks.id,
            role: shareLinks.role,
            createdAt: shareLinks.createdAt,
            expiresAt: shareLinks.expiresAt,
          })
          .from(shareLinks)
          .where(
            and(
              eq(shareLinks.boardId, id),
              sql`${shareLinks.revokedAt} is null and (${shareLinks.expiresAt} is null or ${shareLinks.expiresAt} > now())`,
            ),
          )
      : [];
    return {
      isPublic: access.isPublic,
      members: members.map((m) => ({
        ...m,
        email: m.email ?? null,
        displayName: m.displayName ?? m.email ?? "Unknown user",
        avatarUrl: m.avatarUrl ?? null,
      })),
      invites: pending.map((i) => ({ ...i, expiresAt: i.expiresAt.toISOString() })),
      links: links.map((l) => ({
        ...l,
        createdAt: l.createdAt.toISOString(),
        expiresAt: l.expiresAt?.toISOString() ?? null,
      })),
    };
  });

  app.patch("/boards/:id/sharing", async (request) => {
    const user = requireUser(request);
    const { id } = parse(idParams, request.params);
    const { isPublic } = parse(sharingSettingsSchema, request.body);
    const access = await authorize(deps, id, user.id, "share");
    if (access.isPublic === isPublic) return { isPublic };
    await deps.db.transaction(async (tx) => {
      await tx.update(boards).set({ isPublic }).where(eq(boards.id, id));
      await audit(tx, {
        action: isPublic ? "board.public_on" : "board.public_off",
        actorId: user.id,
        orgId: access.orgId,
        boardId: id,
        targetType: "board",
        targetId: id,
        ip: request.ip,
      });
    });
    if (!isPublic) await deps.revocations.publish({ type: "public_off", boardId: id });
    return { isPublic };
  });

  app.post(
    "/boards/:id/invites",
    { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const user = requireUser(request);
      const { id } = parse(idParams, request.params);
      const body = parse(inviteRequestSchema, request.body);
      const access = await authorize(deps, id, user.id, "share");
      if (body.email === user.email)
        throw new BadRequestError("You already have access to this board.");

      const [existingMember] = await deps.db
        .select({ userId: boardMembers.userId })
        .from(boardMembers)
        .innerJoin(profiles, eq(profiles.id, boardMembers.userId))
        .where(and(eq(boardMembers.boardId, id), eq(profiles.email, body.email)));
      if (existingMember)
        throw new ConflictError("That person is already a member. Change their role instead.");

      const token = newSecretToken();
      const invite = await deps.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(invites)
          .values({
            boardId: id,
            email: body.email,
            role: body.role,
            tokenHash: hashToken(token),
            invitedBy: user.id,
            expiresAt: sql`now() + make_interval(days => ${INVITE_TTL_DAYS})`,
          })
          .returning({ id: invites.id, expiresAt: invites.expiresAt });
        if (!created) throw new Error("invite insert failed");
        await audit(tx, {
          action: "invite.create",
          actorId: user.id,
          orgId: access.orgId,
          boardId: id,
          targetType: "invite",
          targetId: created.id,
          metadata: { email: body.email, role: body.role },
          ip: request.ip,
        });
        return created;
      });

      try {
        await deps.mailer.send(
          await inviteEmail(body.email, {
            inviterName: displayNameFor(user),
            boardTitle: access.title,
            role: body.role,
            acceptUrl: `${deps.appUrl}/invite/${token}`,
          }),
        );
      } catch (error) {
        deps.logger.error({ err: error, inviteId: invite.id }, "failed to send invite email");
        throw new AppError(
          502,
          "EMAIL_FAILED",
          "The invite was created but the email could not be sent. Try again later.",
        );
      }
      return reply.status(201).send({
        id: invite.id,
        email: body.email,
        role: body.role,
        expiresAt: invite.expiresAt.toISOString(),
      });
    },
  );

  app.delete("/boards/:id/invites/:inviteId", async (request, reply) => {
    const user = requireUser(request);
    const { id, inviteId } = parse(inviteParams, request.params);
    const access = await authorize(deps, id, user.id, "share");
    await deps.db.transaction(async (tx) => {
      const revoked = await tx
        .update(invites)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(invites.id, inviteId),
            eq(invites.boardId, id),
            sql`${invites.revokedAt} is null and ${invites.acceptedAt} is null`,
          ),
        )
        .returning({ id: invites.id });
      if (revoked.length === 0) throw new NotFoundError("Invite not found");
      await audit(tx, {
        action: "invite.revoke",
        actorId: user.id,
        orgId: access.orgId,
        boardId: id,
        targetType: "invite",
        targetId: inviteId,
        ip: request.ip,
      });
    });
    return reply.status(204).send();
  });

  app.patch("/boards/:id/members/:userId", async (request) => {
    const user = requireUser(request);
    const { id, userId } = parse(memberParams, request.params);
    const { role } = parse(updateMemberSchema, request.body);
    const access = await authorize(deps, id, user.id, "share");
    await deps.db.transaction(async (tx) => {
      const [member] = await tx
        .select({ role: boardMembers.role })
        .from(boardMembers)
        .where(and(eq(boardMembers.boardId, id), eq(boardMembers.userId, userId)));
      if (!member) throw new NotFoundError("Member not found");
      if (member.role === "owner") throw new ForbiddenError("The owner's role can't be changed.");
      if (member.role === role) return;
      await tx
        .update(boardMembers)
        .set({ role })
        .where(and(eq(boardMembers.boardId, id), eq(boardMembers.userId, userId)));
      await audit(tx, {
        action: "member.role_change",
        actorId: user.id,
        orgId: access.orgId,
        boardId: id,
        targetType: "member",
        targetId: userId,
        metadata: { from: member.role, to: role },
        ip: request.ip,
      });
    });
    await deps.revocations.publish({ type: "member", boardId: id, userId });
    return { userId, role };
  });

  app.delete("/boards/:id/members/:userId", async (request, reply) => {
    const user = requireUser(request);
    const { id, userId } = parse(memberParams, request.params);
    // Owners remove anyone; anyone else may only leave (remove themselves).
    const access = await authorize(deps, id, user.id, userId === user.id ? "read" : "share");
    await deps.db.transaction(async (tx) => {
      const [member] = await tx
        .select({ role: boardMembers.role })
        .from(boardMembers)
        .where(and(eq(boardMembers.boardId, id), eq(boardMembers.userId, userId)));
      if (!member) throw new NotFoundError("Member not found");
      if (member.role === "owner") throw new ForbiddenError("The owner can't be removed.");
      await tx
        .delete(boardMembers)
        .where(and(eq(boardMembers.boardId, id), eq(boardMembers.userId, userId)));
      await audit(tx, {
        action: "member.remove",
        actorId: user.id,
        orgId: access.orgId,
        boardId: id,
        targetType: "member",
        targetId: userId,
        metadata: { role: member.role, left: userId === user.id },
        ip: request.ip,
      });
    });
    await deps.revocations.publish({ type: "member", boardId: id, userId });
    return reply.status(204).send();
  });

  app.post("/boards/:id/share-links", async (request, reply) => {
    const user = requireUser(request);
    const { id } = parse(idParams, request.params);
    const body = parse(createShareLinkSchema, request.body);
    const access = await authorize(deps, id, user.id, "share");
    const token = newSecretToken();
    const link = await deps.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(shareLinks)
        .values({
          boardId: id,
          tokenHash: hashToken(token),
          role: body.role,
          createdBy: user.id,
          expiresAt: body.expiresInDays
            ? sql`now() + make_interval(days => ${body.expiresInDays})`
            : null,
        })
        .returning({
          id: shareLinks.id,
          role: shareLinks.role,
          createdAt: shareLinks.createdAt,
          expiresAt: shareLinks.expiresAt,
        });
      if (!created) throw new Error("share link insert failed");
      await audit(tx, {
        action: "share_link.create",
        actorId: user.id,
        orgId: access.orgId,
        boardId: id,
        targetType: "share_link",
        targetId: created.id,
        metadata: { role: body.role, expiresInDays: body.expiresInDays ?? null },
        ip: request.ip,
      });
      return created;
    });
    const response: CreatedShareLink = {
      id: link.id,
      role: link.role,
      createdAt: link.createdAt.toISOString(),
      expiresAt: link.expiresAt?.toISOString() ?? null,
      token,
    };
    return reply.status(201).send(response);
  });

  app.delete("/boards/:id/share-links/:linkId", async (request, reply) => {
    const user = requireUser(request);
    const { id, linkId } = parse(linkParams, request.params);
    const access = await authorize(deps, id, user.id, "share");
    await deps.db.transaction(async (tx) => {
      const revoked = await tx
        .update(shareLinks)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(shareLinks.id, linkId),
            eq(shareLinks.boardId, id),
            sql`${shareLinks.revokedAt} is null`,
          ),
        )
        .returning({ id: shareLinks.id });
      if (revoked.length === 0) throw new NotFoundError("Share link not found");
      await audit(tx, {
        action: "share_link.revoke",
        actorId: user.id,
        orgId: access.orgId,
        boardId: id,
        targetType: "share_link",
        targetId: linkId,
        ip: request.ip,
      });
    });
    await deps.revocations.publish({ type: "link", boardId: id, linkId });
    return reply.status(204).send();
  });

  /** Which board a share link opens (signed-in users only; the link itself is the secret). */
  app.post(
    "/share-links/resolve",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      requireUser(request);
      const { token } = parse(resolveShareLinkSchema, request.body);
      const [link] = await deps.db
        .select({ boardId: shareLinks.boardId, role: shareLinks.role })
        .from(shareLinks)
        .innerJoin(boards, eq(boards.id, shareLinks.boardId))
        .where(
          and(
            eq(shareLinks.tokenHash, hashToken(token)),
            sql`${shareLinks.revokedAt} is null and (${shareLinks.expiresAt} is null or ${shareLinks.expiresAt} > now()) and ${boards.deletedAt} is null`,
          ),
        );
      if (!link) throw new NotFoundError("This link is invalid, expired or has been revoked.");
      return link;
    },
  );

  /** Accepts an invite; the signed-in email must match the invited address. */
  app.post(
    "/invites/accept",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const user = requireUser(request);
      const { token } = parse(acceptInviteSchema, request.body);
      return deps.db.transaction(async (tx) => {
        const [invite] = await tx
          .select({
            id: invites.id,
            boardId: invites.boardId,
            email: invites.email,
            role: invites.role,
            orgId: boards.orgId,
          })
          .from(invites)
          .innerJoin(boards, eq(boards.id, invites.boardId))
          .where(
            and(
              eq(invites.tokenHash, hashToken(token)),
              sql`${invites.revokedAt} is null and ${invites.acceptedAt} is null and ${invites.expiresAt} > now() and ${boards.deletedAt} is null`,
            ),
          );
        if (!invite)
          throw new NotFoundError("This invite is invalid, expired or has already been used.");
        if (invite.email !== user.email) {
          throw new ForbiddenError(
            `This invite was sent to ${invite.email}. Sign in with that address to accept it.`,
          );
        }
        const role = await addMember(tx, {
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
          metadata: { role },
          ip: request.ip,
        });
        return { boardId: invite.boardId, role };
      });
    },
  );
}
