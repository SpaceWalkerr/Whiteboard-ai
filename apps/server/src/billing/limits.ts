import {
  BOARD_LOCKED_MESSAGE,
  boardsToKeepEditable,
  checkBoardCreate,
  checkEditorSeat,
  seatsToKeepActive,
  type LimitCheck,
} from "@whiteboard/shared/entitlements";
import type { BoardLimitReason } from "@whiteboard/shared/billing";
import {
  and,
  boardEditorSeats,
  boards,
  eq,
  inArray,
  sql,
  type Database,
} from "@whiteboard/shared/db";
import type { BoardAccess } from "../access/boardAccess";
import type { Tx } from "../api/deps";
import { PaymentRequiredError } from "../errors";
import type { RevocationEvent } from "../revocation/bus";
import { loadEntitlement } from "./entitlements";

/** Serializes work on one key for the rest of the transaction (all instances). */
export async function lockKey(tx: Tx, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

export function throwIfBlocked(check: LimitCheck): void {
  if (!check.allowed) throw new PaymentRequiredError(check.code, check.message);
}

/**
 * Board limit (create, duplicate, restore): counted under a per-owner lock in the caller's
 * transaction, so parallel requests can't both take the last slot.
 */
export async function assertBoardSlot(tx: Tx, userId: string, now: Date): Promise<void> {
  await lockKey(tx, `board-limit:${userId}`);
  const entitlement = await loadEntitlement(tx, userId, now);
  if (entitlement.limits.boards === null) return;
  const [row] = await tx
    .select({ owned: sql<number>`count(*)::int` })
    .from(boards)
    .where(and(eq(boards.ownerId, userId), sql`${boards.deletedAt} is null`));
  throwIfBlocked(checkBoardCreate(entitlement, row?.owned ?? 0));
}

/**
 * Brings an owner's boards in line with their current plan: boards above the board limit
 * become read-only (never deleted) and editor seats above the per-board limit are
 * suspended; both come back when the plan allows again. Idempotent. Returns the events that
 * make live sockets re-check their role.
 */
export async function enforceOwnerLimits(
  tx: Tx,
  ownerId: string,
  now: Date,
): Promise<RevocationEvent[]> {
  await lockKey(tx, `board-limit:${ownerId}`);
  const entitlement = await loadEntitlement(tx, ownerId, now);
  const owned = await tx
    .select({ id: boards.id, lockedAt: boards.planLockedAt, updatedAt: boards.updatedAt })
    .from(boards)
    .where(and(eq(boards.ownerId, ownerId), sql`${boards.deletedAt} is null`));
  const events: RevocationEvent[] = [];

  const { editable, locked } = boardsToKeepEditable(owned, entitlement.limits.boards);
  const toLock = locked.filter((b) => b.lockedAt === null).map((b) => b.id);
  const toUnlock = editable.filter((b) => b.lockedAt !== null).map((b) => b.id);
  if (toLock.length > 0)
    await tx.update(boards).set({ planLockedAt: now }).where(inArray(boards.id, toLock));
  if (toUnlock.length > 0)
    await tx.update(boards).set({ planLockedAt: null }).where(inArray(boards.id, toUnlock));
  for (const boardId of [...toLock, ...toUnlock]) events.push({ type: "plan", boardId });

  if (owned.length > 0) {
    const seats = await tx
      .select({
        boardId: boardEditorSeats.boardId,
        userId: boardEditorSeats.userId,
        claimedAt: boardEditorSeats.claimedAt,
        suspended: boardEditorSeats.suspended,
      })
      .from(boardEditorSeats)
      .where(
        inArray(
          boardEditorSeats.boardId,
          owned.map((b) => b.id),
        ),
      );
    const byBoard = new Map<string, typeof seats>();
    for (const seat of seats)
      byBoard.set(seat.boardId, [...(byBoard.get(seat.boardId) ?? []), seat]);
    for (const [boardId, boardSeats] of byBoard) {
      const { active, suspended } = seatsToKeepActive(boardSeats, entitlement);
      for (const [list, value] of [
        [active, false],
        [suspended, true],
      ] as const) {
        const changed = list.filter((seat) => seat.suspended !== value);
        if (changed.length === 0) continue;
        await tx
          .update(boardEditorSeats)
          .set({ suspended: value })
          .where(
            and(
              eq(boardEditorSeats.boardId, boardId),
              inArray(
                boardEditorSeats.userId,
                changed.map((seat) => seat.userId),
              ),
            ),
          );
        for (const seat of changed) events.push({ type: "member", boardId, userId: seat.userId });
      }
    }
  }
  return events;
}

/**
 * Takes an editor seat on a board for `userId` if the owner's plan has one free. The owner
 * never needs a seat. Idempotent; a suspended seat stays suspended (only the owner's plan
 * brings it back, in claim order).
 */
export async function claimEditorSeat(
  db: Database,
  boardId: string,
  ownerId: string,
  userId: string,
  now: Date,
): Promise<LimitCheck> {
  return db.transaction(async (tx) => {
    await lockKey(tx, `editor-seats:${boardId}`);
    const seats = await tx
      .select({ userId: boardEditorSeats.userId, suspended: boardEditorSeats.suspended })
      .from(boardEditorSeats)
      .where(eq(boardEditorSeats.boardId, boardId));
    const ownerEntitlement = await loadEntitlement(tx, ownerId, now);
    const mine = seats.find((seat) => seat.userId === userId);
    const activeCount = seats.filter((seat) => !seat.suspended).length;
    if (mine)
      return mine.suspended ? checkEditorSeat(ownerEntitlement, Infinity) : { allowed: true };
    const check = checkEditorSeat(ownerEntitlement, activeCount);
    if (check.allowed) await tx.insert(boardEditorSeats).values({ boardId, userId }); // claim order = arrival order (database clock)
    return check;
  });
}

/** Whether granting edit access to one more person would exceed the owner's plan (402). */
export async function assertEditorSeatAvailable(
  db: Database | Tx,
  boardId: string,
  ownerId: string,
  userId: string | null,
  now: Date,
): Promise<void> {
  const seats = await db
    .select({ userId: boardEditorSeats.userId, suspended: boardEditorSeats.suspended })
    .from(boardEditorSeats)
    .where(eq(boardEditorSeats.boardId, boardId));
  if (seats.some((seat) => seat.userId === userId && !seat.suspended)) return;
  const active = seats.filter((seat) => !seat.suspended).length;
  throwIfBlocked(checkEditorSeat(await loadEntitlement(db, ownerId, now), active));
}

export interface LimitedAccess {
  /** Why the caller can't write although their role would allow it. */
  limitedBy: BoardLimitReason | null;
  message: string | null;
}

/**
 * Plan limits on top of the caller's role — shared by REST writes, room tickets and the
 * sync server's upgrade check. `claim` takes an editor seat when one is needed (connecting
 * or writing as an editor); reads never claim.
 */
export async function planLimitsFor(
  db: Database,
  access: BoardAccess,
  userId: string | null,
  now: Date,
  options: { claim: boolean },
): Promise<LimitedAccess> {
  if (access.role === null || access.role === "viewer") return { limitedBy: null, message: null };
  if (access.locked) return { limitedBy: "BOARD_LOCKED", message: BOARD_LOCKED_MESSAGE };
  if (access.role === "owner" || userId === null || access.ownerId === null)
    return { limitedBy: null, message: null };
  if (access.editorSeat === "active") return { limitedBy: null, message: null };
  let check: LimitCheck;
  if (access.editorSeat === "suspended" || !options.claim) {
    if (access.editorSeat !== "suspended") return { limitedBy: null, message: null };
    check = checkEditorSeat(await loadEntitlement(db, access.ownerId, now), Infinity);
  } else {
    check = await claimEditorSeat(db, access.boardId, access.ownerId, userId, now);
  }
  return check.allowed
    ? { limitedBy: null, message: null }
    : { limitedBy: "EDITOR_LIMIT", message: check.message };
}
