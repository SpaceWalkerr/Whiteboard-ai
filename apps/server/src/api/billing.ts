import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  PLAN_IDS,
  addTeamMemberSchema,
  changePlanRequestSchema,
  checkoutRequestSchema,
  couponCodeSchema,
  planIdSchema,
  subscriptionIdRequestSchema,
  type CatalogResponse,
  type EditorSeatsResponse,
  type TeamResponse,
} from "@whiteboard/shared/billing";
import { editorSeatsForOthers } from "@whiteboard/shared/entitlements";
import {
  and,
  asc,
  boardEditorSeats,
  boardMembers,
  boards,
  eq,
  inArray,
  memberships,
  organizations,
  plans,
  profiles,
  sql,
  subscriptions,
} from "@whiteboard/shared/db";
import { audit } from "../audit/audit";
import { requireUser } from "../auth/requestAuth";
import { runEffects, noEffects } from "../billing/context";
import { loadEntitlement } from "../billing/entitlements";
import { enforceOwnerLimits, lockKey } from "../billing/limits";
import { WebhookSignatureError } from "../billing/provider";
import {
  billingSummary,
  cancelSubscription,
  changePlan,
  createCheckout,
  previewCoupon,
  refreshMySubscriptions,
  requireBilling,
  startStudentTrial,
} from "../billing/service";
import { refreshTeamSeats, syncSubscription, teamMembersInSeatOrder } from "../billing/sync";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../errors";
import { authorize } from "./boards";
import { billingContext, nowOf, type ApiDeps } from "./deps";
import { parse } from "./validation";

const orgParams = z.object({ orgId: z.uuid() });
const orgMemberParams = z.object({ orgId: z.uuid(), userId: z.uuid() });
const seatParams = z.object({ id: z.uuid(), userId: z.uuid() });
const boardParams = z.object({ id: z.uuid() });
const couponQuery = z.object({ code: couponCodeSchema, planId: planIdSchema });

/** Billing for signed-in users (plans, checkout, subscription management, teams). */
export function registerBillingRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const ctx = billingContext(deps);

  /** The price list (public: the pricing page shows it signed out). */
  app.get("/billing/plans", async (): Promise<CatalogResponse> => {
    const rows = await deps.db
      .select()
      .from(plans)
      .where(and(eq(plans.active, true), inArray(plans.id, [...PLAN_IDS])))
      .orderBy(asc(plans.amountMinor));
    return {
      plans: rows.map((row) => ({
        id: planIdSchema.parse(row.id),
        tier: row.tier,
        interval: row.interval,
        currency: row.currency,
        amountMinor: row.amountMinor,
        perSeat: row.tier === "team",
      })),
      checkoutAvailable: deps.billing !== undefined,
    };
  });

  app.get("/billing", async (request) => billingSummary(ctx, requireUser(request)));

  app.get("/billing/coupon", async (request) => {
    requireUser(request);
    const query = parse(couponQuery, request.query);
    return previewCoupon(ctx, query.code, query.planId);
  });

  app.post(
    "/billing/checkout",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request) =>
      createCheckout(
        ctx,
        requireUser(request),
        parse(checkoutRequestSchema, request.body),
        request.ip,
      ),
  );

  /** After the provider's checkout: fetch the caller's subscriptions now (webhook-independent). */
  app.post(
    "/billing/refresh",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request) => {
      const user = requireUser(request);
      await refreshMySubscriptions(ctx, user.id);
      return billingSummary(ctx, user);
    },
  );

  app.post("/billing/cancel", async (request) => {
    const user = requireUser(request);
    const { subscriptionId } = parse(subscriptionIdRequestSchema, request.body);
    await cancelSubscription(ctx, user, subscriptionId, request.ip);
    return billingSummary(ctx, user);
  });

  app.post("/billing/change-plan", async (request) =>
    changePlan(ctx, requireUser(request), parse(changePlanRequestSchema, request.body), request.ip),
  );

  app.post(
    "/billing/student-trial",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request) => {
      const endsAt = await startStudentTrial(ctx, requireUser(request), request.ip);
      return { activeUntil: endsAt.toISOString() };
    },
  );

  // ── Team workspaces (seats) ──────────────────────────────────────────────────────────────

  async function teamOf(orgId: string, userId: string) {
    const [row] = await deps.db
      .select({ name: organizations.name, kind: organizations.kind, role: memberships.role })
      .from(organizations)
      .leftJoin(
        memberships,
        and(eq(memberships.orgId, organizations.id), eq(memberships.userId, userId)),
      )
      .where(eq(organizations.id, orgId));
    if (row?.kind !== "team" || row.role === null) throw new NotFoundError("Team not found");
    return { name: row.name, role: row.role };
  }

  async function seatsOf(orgId: string): Promise<number> {
    const [sub] = await deps.db
      .select({ quantity: subscriptions.quantity })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.orgId, orgId),
          inArray(subscriptions.status, ["authenticated", "active", "past_due", "halted"]),
        ),
      );
    return sub?.quantity ?? 0;
  }

  app.get("/teams/:orgId", async (request): Promise<TeamResponse> => {
    const user = requireUser(request);
    const { orgId } = parse(orgParams, request.params);
    const team = await teamOf(orgId, user.id);
    const seats = await seatsOf(orgId);
    const members = await deps.db
      .select({
        userId: memberships.userId,
        role: memberships.role,
        email: profiles.email,
        displayName: profiles.displayName,
      })
      .from(memberships)
      .leftJoin(profiles, eq(profiles.id, memberships.userId))
      .where(eq(memberships.orgId, orgId));
    const order = await deps.db.transaction((tx) => teamMembersInSeatOrder(tx, orgId));
    const byId = new Map(members.map((m) => [m.userId, m]));
    return {
      orgId,
      name: team.name,
      seats,
      canManage: team.role === "owner" || team.role === "admin",
      members: order.flatMap((userId, index) => {
        const m = byId.get(userId);
        return m
          ? [
              {
                userId,
                role: m.role,
                email: m.email,
                displayName: m.displayName ?? m.email ?? "Unknown user",
                hasSeat: index < seats,
              },
            ]
          : [];
      }),
    };
  });

  app.post("/teams/:orgId/members", async (request, reply) => {
    const user = requireUser(request);
    const { orgId } = parse(orgParams, request.params);
    const { email } = parse(addTeamMemberSchema, request.body);
    const team = await teamOf(orgId, user.id);
    if (team.role === "member") throw new ForbiddenError("Only team admins can add members.");
    const effects = noEffects();
    const added = await deps.db.transaction(async (tx) => {
      await lockKey(tx, `team-members:${orgId}`);
      const [person] = await tx
        .select({ id: profiles.id })
        .from(profiles)
        .where(eq(profiles.email, email));
      if (!person)
        throw new NotFoundError(
          "No account uses that email yet. Ask them to sign in to Whiteboard.ai once, then add them.",
        );
      const [count] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(memberships)
        .where(eq(memberships.orgId, orgId));
      const seats = await seatsOf(orgId);
      if ((count?.n ?? 0) >= seats)
        throw new ConflictError(
          `All ${String(seats)} seats are taken. Add seats in billing settings first.`,
        );
      const inserted = await tx
        .insert(memberships)
        .values({ orgId, userId: person.id, role: "member" })
        .onConflictDoNothing()
        .returning({ userId: memberships.userId });
      if (inserted.length === 0) throw new ConflictError("They're already in the team.");
      for (const userId of await refreshTeamSeats(tx, orgId, nowOf(deps)))
        effects.revocations.push(...(await enforceOwnerLimits(tx, userId, nowOf(deps))));
      await audit(tx, {
        action: "team.member_add",
        actorId: user.id,
        orgId,
        targetType: "team",
        targetId: person.id,
        ip: request.ip,
      });
      return person.id;
    });
    await runEffects(ctx, effects);
    return reply.status(201).send({ userId: added });
  });

  app.delete("/teams/:orgId/members/:userId", async (request, reply) => {
    const user = requireUser(request);
    const { orgId, userId } = parse(orgMemberParams, request.params);
    const team = await teamOf(orgId, user.id);
    if (team.role === "member" && userId !== user.id)
      throw new ForbiddenError("Only team admins can remove members.");
    const effects = noEffects();
    await deps.db.transaction(async (tx) => {
      await lockKey(tx, `team-members:${orgId}`);
      const [member] = await tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
      if (!member) throw new NotFoundError("Member not found");
      if (member.role === "owner") throw new ForbiddenError("The team's owner can't be removed.");
      await tx
        .delete(memberships)
        .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
      for (const affected of await refreshTeamSeats(tx, orgId, nowOf(deps)))
        effects.revocations.push(...(await enforceOwnerLimits(tx, affected, nowOf(deps))));
      // Their access to the team's boards came from membership: end live sessions.
      const teamBoards = await tx
        .select({ id: boards.id })
        .from(boards)
        .where(eq(boards.orgId, orgId));
      for (const board of teamBoards)
        effects.revocations.push({ type: "member", boardId: board.id, userId });
      await audit(tx, {
        action: "team.member_remove",
        actorId: user.id,
        orgId,
        targetType: "team",
        targetId: userId,
        metadata: { left: userId === user.id },
        ip: request.ip,
      });
    });
    await runEffects(ctx, effects);
    return reply.status(204).send();
  });

  // ── Editor seats on a board ──────────────────────────────────────────────────────────────

  app.get("/boards/:id/editor-seats", async (request): Promise<EditorSeatsResponse> => {
    const user = requireUser(request);
    const { id } = parse(boardParams, request.params);
    const access = await authorize(deps, id, user.id, "share");
    const owner = access.ownerId
      ? await loadEntitlement(deps.db, access.ownerId, nowOf(deps))
      : null;
    const seats = await deps.db
      .select({
        userId: boardEditorSeats.userId,
        claimedAt: boardEditorSeats.claimedAt,
        suspended: boardEditorSeats.suspended,
        email: profiles.email,
        displayName: profiles.displayName,
      })
      .from(boardEditorSeats)
      .leftJoin(profiles, eq(profiles.id, boardEditorSeats.userId))
      .where(eq(boardEditorSeats.boardId, id))
      .orderBy(asc(boardEditorSeats.claimedAt));
    return {
      limit: owner ? editorSeatsForOthers(owner) : 0,
      seats: seats.map((seat) => ({
        userId: seat.userId,
        email: seat.email,
        displayName: seat.displayName ?? seat.email ?? "Unknown user",
        active: !seat.suspended,
        claimedAt: seat.claimedAt.toISOString(),
      })),
    };
  });

  /** The owner frees a seat: the person becomes a viewer of the board (a member stays one). */
  app.delete("/boards/:id/editor-seats/:userId", async (request, reply) => {
    const user = requireUser(request);
    const { id, userId } = parse(seatParams, request.params);
    const access = await authorize(deps, id, user.id, "share");
    const effects = noEffects();
    await deps.db.transaction(async (tx) => {
      await lockKey(tx, `editor-seats:${id}`);
      const removed = await tx
        .delete(boardEditorSeats)
        .where(and(eq(boardEditorSeats.boardId, id), eq(boardEditorSeats.userId, userId)))
        .returning({ userId: boardEditorSeats.userId });
      if (removed.length === 0) throw new NotFoundError("Seat not found");
      // Otherwise they'd take the seat straight back at their next connection. (Someone
      // editing through a share link can re-claim it: revoke the link to stop that.)
      await tx
        .update(boardMembers)
        .set({ role: "viewer" })
        .where(
          and(
            eq(boardMembers.boardId, id),
            eq(boardMembers.userId, userId),
            eq(boardMembers.role, "editor"),
          ),
        );
      // A suspended seat may now fit under the plan.
      if (access.ownerId)
        effects.revocations.push(...(await enforceOwnerLimits(tx, access.ownerId, nowOf(deps))));
      effects.revocations.push({ type: "member", boardId: id, userId });
      await audit(tx, {
        action: "editor_seat.release",
        actorId: user.id,
        orgId: access.orgId,
        boardId: id,
        targetType: "editor_seat",
        targetId: userId,
        ip: request.ip,
      });
    });
    await runEffects(ctx, effects);
    return reply.status(204).send();
  });
}

/**
 * Payment provider webhooks. Outside the user API scope (no session) and with a raw-body
 * parser: the signature covers the exact bytes. Answers 2xx only after the event is stored
 * and applied; any failure answers 5xx so the provider retries.
 */
export function registerBillingWebhook(app: FastifyInstance, deps: ApiDeps): void {
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer", bodyLimit: 256 * 1024 },
    (_request, body, done) => {
      done(null, body);
    },
  );
  const ctx = billingContext(deps);

  app.post("/billing/webhooks/razorpay", async (request, reply) => {
    const config = requireBilling(ctx);
    if (!Buffer.isBuffer(request.body)) throw new BadRequestError("Expected a JSON body.");
    let event;
    try {
      event = config.provider.verifyWebhook(request.body, request.headers);
    } catch (error) {
      if (error instanceof WebhookSignatureError) {
        request.log.warn({ reason: error.message }, "billing webhook rejected");
        return reply
          .status(400)
          .send({ error: { code: "BAD_SIGNATURE", message: "Invalid signature" } });
      }
      throw error;
    }
    if (event.subscriptionId === null) {
      // Not about a subscription (we don't act on it); acknowledged so it isn't retried.
      request.log.info({ eventType: event.type }, "billing webhook ignored");
      return { received: true, outcome: "ignored" };
    }
    const outcome = await syncSubscription(ctx, event.subscriptionId, event);
    request.log.info(
      { eventType: event.type, eventId: event.id, outcome },
      "billing webhook processed",
    );
    return { received: true, outcome };
  });
}
