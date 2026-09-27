import { describe, expect, it } from "vitest";
import {
  boardsToKeepEditable,
  checkAiReview,
  checkBoardCreate,
  checkEditorSeat,
  checkFeature,
  effectiveEntitlement,
  FREE_ENTITLEMENT,
  isStudentEmail,
  nextGrace,
  seatsToKeepActive,
  subscriptionValidUntil,
  type EntitlementGrant,
  type SubscriptionState,
} from "../src/entitlements";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-09-27T12:00:00Z");
const at = (days: number) => new Date(now.getTime() + days * DAY);

const grant = (overrides: Partial<EntitlementGrant>): EntitlementGrant => ({
  plan: "pro",
  source: "subscription",
  sourceId: "sub-1",
  validUntil: null,
  ...overrides,
});

describe("effectiveEntitlement", () => {
  it("is Free without grants", () => {
    expect(effectiveEntitlement([], now)).toEqual(FREE_ENTITLEMENT);
  });

  it("picks the highest plan that is still valid", () => {
    const ent = effectiveEntitlement(
      [
        grant({ plan: "pro", source: "student_trial", validUntil: at(30) }),
        grant({ plan: "team", source: "team_seat", orgId: "org", seats: 4, validUntil: null }),
      ],
      now,
    );
    expect(ent.plan).toBe("team");
    expect(ent.pool).toEqual({ orgId: "org", seats: 4 });
    expect(ent.reviewsPerMonth).toBe(1200);
  });

  it("ignores expired grants, compared with now at every call", () => {
    const grants = [grant({ validUntil: at(1) })];
    expect(effectiveEntitlement(grants, now).plan).toBe("pro");
    expect(effectiveEntitlement(grants, at(1)).plan).toBe("free");
    expect(effectiveEntitlement(grants, at(2)).plan).toBe("free");
  });

  it("prefers the longer-lasting grant of the same plan", () => {
    const ent = effectiveEntitlement(
      [grant({ sourceId: "a", validUntil: at(3) }), grant({ sourceId: "b", validUntil: null })],
      now,
    );
    expect(ent.validUntil).toBeNull();
  });

  it("applies a review override", () => {
    expect(
      effectiveEntitlement([grant({ aiReviewsPerMonthOverride: 7 })], now).reviewsPerMonth,
    ).toBe(7);
  });
});

describe("subscriptionValidUntil", () => {
  const sub = (overrides: Partial<SubscriptionState>): SubscriptionState => ({
    status: "active",
    currentPeriodEnd: at(20),
    cancelAtPeriodEnd: false,
    graceUntil: null,
    ...overrides,
  });

  it("is open-ended while active and renewing", () => {
    expect(subscriptionValidUntil(sub({}))).toBeNull();
    expect(subscriptionValidUntil(sub({ status: "authenticated" }))).toBeNull();
  });

  it("runs to the end of the paid period after cancelling", () => {
    expect(subscriptionValidUntil(sub({ cancelAtPeriodEnd: true }))).toEqual(at(20));
    expect(subscriptionValidUntil(sub({ status: "cancelled" }))).toEqual(at(20));
  });

  it("runs to the end of the grace period after a failed payment", () => {
    expect(subscriptionValidUntil(sub({ status: "past_due", graceUntil: at(7) }))).toEqual(at(7));
    expect(subscriptionValidUntil(sub({ status: "halted", graceUntil: at(2) }))).toEqual(at(2));
    expect(subscriptionValidUntil(sub({ status: "cancelled", graceUntil: at(2) }))).toEqual(at(2));
  });

  it("grants nothing before payment or while paused", () => {
    expect(subscriptionValidUntil(sub({ status: "created" }))).toBe(false);
    expect(subscriptionValidUntil(sub({ status: "paused" }))).toBe(false);
    expect(subscriptionValidUntil(sub({ status: "expired", currentPeriodEnd: null }))).toBe(false);
  });
});

describe("nextGrace", () => {
  it("starts 7 days after the first failure and never extends", () => {
    const first = nextGrace({ status: "active", graceUntil: null }, "past_due", now);
    expect(first).toEqual(at(7));
    expect(nextGrace({ status: "past_due", graceUntil: first }, "halted", at(3))).toEqual(at(7));
  });

  it("ends when a payment succeeds", () => {
    expect(nextGrace({ status: "past_due", graceUntil: at(7) }, "active", at(1))).toBeNull();
  });

  it("keeps remaining grace when the subscription ends", () => {
    expect(nextGrace({ status: "halted", graceUntil: at(7) }, "cancelled", at(1))).toEqual(at(7));
    expect(nextGrace({ status: "active", graceUntil: null }, "cancelled", now)).toBeNull();
  });
});

describe("checks", () => {
  const free = FREE_ENTITLEMENT;
  const pro = effectiveEntitlement([grant({})], now);

  it("limits Free to 3 boards", () => {
    expect(checkBoardCreate(free, 2).allowed).toBe(true);
    const blocked = checkBoardCreate(free, 3);
    expect(blocked).toMatchObject({ allowed: false, code: "BOARD_LIMIT", limit: 3 });
    expect(checkBoardCreate(pro, 10_000).allowed).toBe(true);
  });

  it("gives Free boards 3 editors: the owner and 2 seats", () => {
    expect(checkEditorSeat(free, 1).allowed).toBe(true);
    expect(checkEditorSeat(free, 2)).toMatchObject({ allowed: false, code: "EDITOR_LIMIT" });
    expect(checkEditorSeat(pro, 8).allowed).toBe(true);
    expect(checkEditorSeat(pro, 9).allowed).toBe(false);
  });

  it("checks AI allowances and features", () => {
    expect(checkAiReview(free, 4).allowed).toBe(true);
    expect(checkAiReview(free, 5)).toMatchObject({ allowed: false, code: "QUOTA_EXCEEDED" });
    expect(checkFeature(free, "privateRooms")).toMatchObject({ code: "PLAN_REQUIRED" });
    expect(checkFeature(pro, "privateRooms").allowed).toBe(true);
    expect(checkFeature(pro, "interviewMode").allowed).toBe(false);
  });
});

describe("boardsToKeepEditable", () => {
  const board = (id: string, updatedDaysAgo: number, locked = false) => ({
    id,
    updatedAt: at(-updatedDaysAgo),
    lockedAt: locked ? at(-1) : null,
  });

  it("keeps the most recently edited boards and locks the rest", () => {
    const { editable, locked } = boardsToKeepEditable(
      [board("a", 5), board("b", 1), board("c", 3), board("d", 2), board("e", 9)],
      3,
    );
    expect(editable.map((b) => b.id)).toEqual(["b", "d", "c"]);
    expect(locked.map((b) => b.id)).toEqual(["a", "e"]);
  });

  it("never swaps an editable board for a locked one that looks newer", () => {
    const { editable } = boardsToKeepEditable(
      [board("old", 30), board("locked-new", 0, true), board("mid", 10), board("x", 20)],
      3,
    );
    expect(editable.map((b) => b.id)).toEqual(["mid", "x", "old"]);
  });

  it("unlocks everything without a limit", () => {
    expect(boardsToKeepEditable([board("a", 1, true)], null).locked).toEqual([]);
  });
});

describe("seatsToKeepActive", () => {
  it("keeps the earliest claims under the owner's plan", () => {
    const seats = ["c", "a", "b"].map((userId, i) => ({ userId, claimedAt: at(-10 + i) }));
    const { active, suspended } = seatsToKeepActive(seats, FREE_ENTITLEMENT);
    expect(active.map((s) => s.userId)).toEqual(["c", "a"]);
    expect(suspended.map((s) => s.userId)).toEqual(["b"]);
  });
});

describe("isStudentEmail", () => {
  it.each([
    ["alice@mit.edu", true],
    ["bob@cs.stanford.edu", true],
    ["priya@iitb.ac.in", true],
    ["r@cse.iitd.ac.in", true],
    ["UPPER@MIT.EDU", true],
    ["x@edu", false],
    ["x@ac.in", false],
    ["x@gmail.com", false],
    ["x@edu.evil.com", false],
    ["x@mit.edu.in", false],
    ["x@notac.in", false],
    ["x@mit..edu", false],
    ["no-at-sign.edu", false],
  ])("%s → %s", (email, expected) => {
    expect(isStudentEmail(email)).toBe(expected);
  });
});
