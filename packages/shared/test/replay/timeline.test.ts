// Replay fixture: a scripted session (creates, moves, style edits, deletes, undo, two users
// editing concurrently). Every update is recorded with a time, like the server stores them;
// the board reconstructed at time T must equal the board as it was at T.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BoardHistory, BoardStore } from "../../src/board";
import { ReplayTimeline, shapeRecords, type ReplayStep } from "../../src/replay";
import { database, rect } from "../board/fixtures";

interface Recorded {
  base: Uint8Array;
  steps: ReplayStep[];
  /** The board after each moment: [time, shapes]. */
  truth: [number, Record<string, unknown>][];
  start: number;
  end: number;
}

/**
 * Two users on two documents, synced like the server would: each edit's update is recorded
 * at the current fake time and applied to the other side. Several edits may share one time
 * (one database batch).
 */
function recordSession(): Recorded {
  const alice = new BoardStore({ userId: "alice" });
  const bob = new BoardStore({ userId: "bob", doc: new Y.Doc() });
  const history = new BoardHistory(alice);
  const server = new Y.Doc();
  let now = 1_000_000;
  const steps: ReplayStep[] = [];
  const truth: Recorded["truth"] = [];
  let recording = false;

  for (const store of [alice, bob]) {
    store.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "sync") return;
      Y.applyUpdate(server, update, "sync");
      for (const other of [alice, bob])
        if (other !== store) Y.applyUpdate(other.doc, update, "sync");
      if (recording) steps.push({ t: now, update });
    });
  }
  const snap = () => {
    truth.push([now, shapeRecords(server)]);
  };

  // Before the session starts: becomes the base.
  const lb = rect({ id: "lb", label: "LB" });
  alice.createShape(lb);
  alice.createShape(database({ id: "db", label: "Primary" }));
  const base = Y.encodeStateAsUpdate(server);
  const start = now;
  recording = true;
  truth.push([now, shapeRecords(server)]);

  now += 1000;
  bob.createShape(rect({ id: "svc", label: "Service" }));
  snap();

  now += 250;
  alice.updateShape("lb", { x: 40, y: 20 });
  // Same batch (same time): two more edits.
  alice.updateShape("lb", { x: 80 });
  bob.updateShape("svc", { style: { ...rect().style, fill: "#fde68a" } });
  snap();

  now += 3000;
  alice.deleteShapes(["db"]);
  snap();

  now += 10;
  history.undo(); // alice restores the database
  snap();

  now += 500;
  // Concurrent edits to the same shape from both users (last writer wins per field).
  alice.updateShape("svc", { label: "Orders" });
  bob.updateShape("svc", { w: 240 });
  snap();

  for (let i = 0; i < 25; i++) {
    now += 40;
    bob.createShape(rect({ id: `r${String(i)}`, x: i * 10 }));
    snap();
  }

  now += 700;
  bob.deleteShapes(["r3", "r7", "svc"]);
  snap();

  return { base, steps, truth, start, end: now };
}

describe("ReplayTimeline", () => {
  const session = recordSession();

  it.each([1, 3, 200])(
    "reconstructs the board at every recorded moment (keyframe every %i steps)",
    (every) => {
      const timeline = new ReplayTimeline(session.base, session.steps, session, every);
      for (const [t, expected] of session.truth) {
        const doc = timeline.docAt(t);
        expect(shapeRecords(doc), `board at t=${String(t)}`).toEqual(expected);
        doc.destroy();
      }
    },
  );

  it("shows the previous state between moments and the base before the first", () => {
    const timeline = new ReplayTimeline(session.base, session.steps, session, 4);
    const [first, second] = session.truth;
    if (!first || !second) throw new Error("fixture too short");
    const before = timeline.docAt(session.start - 1);
    expect(shapeRecords(before)).toEqual(first[1]);
    const between = timeline.docAt(second[0] - 1);
    expect(shapeRecords(between)).toEqual(first[1]);
    const after = timeline.docAt(session.end + 60_000);
    expect(shapeRecords(after)).toEqual(session.truth.at(-1)?.[1]);
    for (const doc of [before, between, after]) doc.destroy();
  });

  it("gives the same result seeking backwards, forwards and playing incrementally", () => {
    const timeline = new ReplayTimeline(session.base, session.steps, session, 5);
    const times = session.truth.map(([t]) => t);
    const shuffled = [...times].reverse().concat(times.filter((_, i) => i % 3 === 0));
    for (const t of shuffled) {
      const doc = timeline.docAt(t);
      expect(shapeRecords(doc)).toEqual(session.truth.find(([tt]) => tt === t)?.[1]);
      doc.destroy();
    }
    // Playing forward on one document, step by step, passes through every recorded state.
    const playing = timeline.docAfter(0);
    let applied = 0;
    for (const [t, expected] of session.truth) {
      const count = timeline.countAt(t);
      timeline.applySteps(playing, applied, count);
      applied = count;
      expect(shapeRecords(playing)).toEqual(expected);
    }
    playing.destroy();
  });

  it("keeps time monotonic when stored timestamps go backwards", () => {
    const [a, b, c] = session.steps;
    if (!a || !b || !c) throw new Error("fixture too short");
    const timeline = new ReplayTimeline(
      session.base,
      [
        { t: 100, update: a.update },
        { t: 90, update: b.update },
        { t: 120, update: c.update },
      ],
      { start: 50, end: 120 },
    );
    expect(timeline.steps.map((s) => s.t)).toEqual([100, 100, 120]);
    expect(timeline.countAt(99)).toBe(0);
    expect(timeline.countAt(100)).toBe(2);
    expect(timeline.end).toBe(120);
  });

  it("handles a session with no edits", () => {
    const timeline = new ReplayTimeline(session.base, [], { start: 10, end: 20 });
    const doc = timeline.docAt(15);
    expect(Object.keys(shapeRecords(doc)).sort()).toEqual(["db", "lb"]);
    doc.destroy();
  });
});
