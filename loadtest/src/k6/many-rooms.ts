// Scenario (b): 2,000 connections across 200 rooms (10 per room). A busy-but-realistic mix:
// each tab moves its cursor twice a second and edits a shape every 5 seconds.
import exec from "k6/execution";
import { loadSeed, runSession, summarize, TREND_STATS } from "./session";

const CONNECTIONS = Number(__ENV.CONNECTIONS ?? 2000);
const HOLD_SECONDS = Number(__ENV.HOLD_SECONDS ?? 120);
// Connections arrive over two minutes (~17/s): each upgrade runs one access query.
const RAMP_SECONDS = Number(__ENV.RAMP_SECONDS ?? 120);
/** After the ramp, before measuring: rooms finish loading, connections settle. */
const SETTLE_SECONDS = Number(__ENV.SETTLE_SECONDS ?? 15);

const seed = loadSeed(__ENV.SEED ?? "../.data/seed-b.json");

export const options = {
  summaryTrendStats: TREND_STATS,
  scenarios: {
    tabs: {
      executor: "per-vu-iterations",
      vus: CONNECTIONS,
      iterations: 1,
      maxDuration: `${HOLD_SECONDS + RAMP_SECONDS + SETTLE_SECONDS + 60}s`,
    },
  },
  thresholds: {
    edit_propagation_ms: ["p(95)<150"],
    ws_errors: ["count==0"],
    ws_unexpected_closes: ["count==0"],
    edits_missed: ["count==0"],
  },
};

export default function tab(): void {
  const vu = exec.vu.idInTest;
  const room = seed.rooms[(vu - 1) % seed.rooms.length];
  const member = room?.members[Math.floor((vu - 1) / seed.rooms.length) % room.members.length];
  if (!room || !member) throw new Error("seed has no room/member for this VU");
  const delay = ((vu - 1) / CONNECTIONS) * RAMP_SECONDS * 1000;
  runSession({
    wsUrl: __ENV.WS_URL ?? seed.wsUrl,
    origin: seed.origin,
    boardId: room.boardId,
    userId: member.userId,
    ticket: member.ticket,
    vu,
    startDelayMs: delay,
    holdMs: (HOLD_SECONDS + RAMP_SECONDS + SETTLE_SECONDS) * 1000 - delay,
    editEveryMs: Number(__ENV.EDIT_EVERY_MS ?? 5000),
    measureFrom: exec.scenario.startTime + (RAMP_SECONDS + SETTLE_SECONDS) * 1000,
    cursorEveryMs: Number(__ENV.CURSOR_EVERY_MS ?? 500),
  });
}

export function handleSummary(data: Parameters<typeof summarize>[0]) {
  return summarize(data, __ENV.OUT ?? ".data/result-b.json");
}
