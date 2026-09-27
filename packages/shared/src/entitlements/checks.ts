import type { Entitlement } from "./derive";
import { PLAN_NAMES, type Plan } from "./limits";

/**
 * Every plan-limit decision in one place. The REST API and the sync server call these with
 * facts they loaded (counts, the user's entitlement); the web app uses the same codes to show
 * the matching upgrade prompt. Pure functions: easy to test, impossible to disagree.
 */

export const LIMIT_CODES = [
  "BOARD_LIMIT",
  "EDITOR_LIMIT",
  "BOARD_LOCKED",
  "QUOTA_EXCEEDED",
  "PLAN_REQUIRED",
] as const;
export type LimitCode = (typeof LIMIT_CODES)[number];

export type LimitCheck =
  | { allowed: true }
  | { allowed: false; code: LimitCode; message: string; plan: Plan; limit: number | null };

const ALLOWED: LimitCheck = { allowed: true };

export type Feature = "liveHints" | "interviewMode" | "privateRooms";

const FEATURE_TEXT: Record<Feature, string> = {
  liveHints: "Live AI hints are included in the Pro and Team plans.",
  interviewMode: "Interview mode is included in the Team plan.",
  privateRooms: "Private end-to-end encrypted boards are included in the Pro and Team plans.",
};

export function checkFeature(entitlement: Entitlement, feature: Feature): LimitCheck {
  if (entitlement.limits[feature]) return ALLOWED;
  return {
    allowed: false,
    code: "PLAN_REQUIRED",
    message: FEATURE_TEXT[feature],
    plan: entitlement.plan,
    limit: null,
  };
}

/** `ownedBoards`: boards the user owns that aren't in the trash. */
export function checkBoardCreate(entitlement: Entitlement, ownedBoards: number): LimitCheck {
  const limit = entitlement.limits.boards;
  if (limit === null || ownedBoards < limit) return ALLOWED;
  return {
    allowed: false,
    code: "BOARD_LIMIT",
    message: `The ${PLAN_NAMES[entitlement.plan]} plan includes ${String(limit)} boards. Upgrade for unlimited boards, or move a board to the trash.`,
    plan: entitlement.plan,
    limit,
  };
}

/**
 * Editor seats other than the owner's: `claimed` seats are already taken on this board,
 * `ownerEntitlement` is the board owner's plan (the owner pays for their collaborators).
 */
export function checkEditorSeat(ownerEntitlement: Entitlement, claimed: number): LimitCheck {
  const others = editorSeatsForOthers(ownerEntitlement);
  if (claimed < others) return ALLOWED;
  return {
    allowed: false,
    code: "EDITOR_LIMIT",
    message: `This board has reached the ${PLAN_NAMES[ownerEntitlement.plan]} plan's limit of ${String(ownerEntitlement.limits.editorsPerBoard)} editors. You can view it; the owner can upgrade or free a seat.`,
    plan: ownerEntitlement.plan,
    limit: ownerEntitlement.limits.editorsPerBoard,
  };
}

/** Seats available to people other than the owner (who always has one). */
export function editorSeatsForOthers(ownerEntitlement: Entitlement): number {
  return Math.max(0, ownerEntitlement.limits.editorsPerBoard - 1);
}

export function checkAiReview(entitlement: Entitlement, usedThisMonth: number): LimitCheck {
  if (usedThisMonth < entitlement.reviewsPerMonth) return ALLOWED;
  const who = entitlement.pool ? "your team has" : "you've";
  return {
    allowed: false,
    code: "QUOTA_EXCEEDED",
    message: `${who[0]?.toUpperCase() ?? ""}${who.slice(1)} used all ${String(entitlement.reviewsPerMonth)} AI reviews included in the ${PLAN_NAMES[entitlement.plan]} plan this month.`,
    plan: entitlement.plan,
    limit: entitlement.reviewsPerMonth,
  };
}

export const BOARD_LOCKED_MESSAGE =
  "This board is read-only because it's above your plan's board limit. Upgrade, or move another board to the trash to edit it again.";

/**
 * Which of an owner's boards stay editable under `limit`. Boards that are already editable
 * keep their place (a board never flips just because another one was edited), then the most
 * recently edited ones. Nothing is ever deleted: the rest become read-only.
 */
export function boardsToKeepEditable<
  B extends { id: string; lockedAt: Date | null; updatedAt: Date },
>(boards: readonly B[], limit: number | null): { editable: B[]; locked: B[] } {
  if (limit === null) return { editable: [...boards], locked: [] };
  const ordered = [...boards].sort((a, b) => {
    const aLocked = a.lockedAt === null ? 0 : 1;
    const bLocked = b.lockedAt === null ? 0 : 1;
    if (aLocked !== bLocked) return aLocked - bLocked;
    const byTime = b.updatedAt.getTime() - a.updatedAt.getTime();
    return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
  });
  return { editable: ordered.slice(0, limit), locked: ordered.slice(limit) };
}

/**
 * Which editor seats stay active under the owner's plan: the earliest claimed ones.
 * Suspended seats come back (in claim order) when the owner upgrades.
 */
export function seatsToKeepActive<S extends { userId: string; claimedAt: Date }>(
  seats: readonly S[],
  ownerEntitlement: Entitlement,
): { active: S[]; suspended: S[] } {
  const ordered = [...seats].sort(
    (a, b) => a.claimedAt.getTime() - b.claimedAt.getTime() || a.userId.localeCompare(b.userId),
  );
  const keep = editorSeatsForOthers(ownerEntitlement);
  return { active: ordered.slice(0, keep), suspended: ordered.slice(keep) };
}

/**
 * Student offer: an academic email domain (".edu" or ".ac.in", including subdomains such as
 * cs.mit.edu or iitb.ac.in). "edu.example.com" and "x.edu.in" don't count.
 */
export function isStudentEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 1) return false;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(domain) || domain.includes("..")) return false;
  const labels = domain.split(".");
  if (labels.some((label) => label.length === 0)) return false;
  const tld = labels.slice(-1).join(".");
  const last2 = labels.slice(-2).join(".");
  if (tld === "edu") return labels.length >= 2;
  if (last2 === "ac.in") return labels.length >= 3;
  return false;
}
