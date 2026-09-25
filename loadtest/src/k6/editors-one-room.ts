// Scenario (a): 50 editors in ONE room, spread over the instances by the load balancer.
// Every editor moves its cursor at 10 Hz and edits a shape twice a second.
import exec from "k6/execution";
import { loadSeed, runSession, summarize, TREND_STATS } from "./session";

const EDITORS = Number(__ENV.EDITORS ?? 50);
const HOLD_SECONDS = Number(__ENV.HOLD_SECONDS ?? 120);
const RAMP_SECONDS = Number(__ENV.RAMP_SECONDS ?? 10);
/** After the ramp, before measuring: rooms finish loading, connections settle. */
const SETTLE_SECONDS = Number(__ENV.SETTLE_SECONDS ?? 10);

const seed = loadSeed(__ENV.SEED ?? "../.data/seed-a.json");

export const options = {
  summaryTrendStats: TREND_STATS,
  scenarios: {
    editors: {
      executor: "per-vu-iterations",
      vus: EDITORS,
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

export default function editor(): void {
  const vu = exec.vu.idInTest;
  const room = seed.rooms[0];
  const member = room?.members[(vu - 1) % room.members.length];
  if (!room || !member) throw new Error("seed has no room/member for this VU");
  runSession({
    wsUrl: __ENV.WS_URL ?? seed.wsUrl,
    origin: seed.origin,
    boardId: room.boardId,
    userId: member.userId,
    ticket: member.ticket,
    vu,
    startDelayMs: ((vu - 1) / EDITORS) * RAMP_SECONDS * 1000,
    // Everyone stays until the last editor has been connected for HOLD_SECONDS.
    holdMs:
      (HOLD_SECONDS + RAMP_SECONDS + SETTLE_SECONDS) * 1000 -
      ((vu - 1) / EDITORS) * RAMP_SECONDS * 1000,
    editEveryMs: Number(__ENV.EDIT_EVERY_MS ?? 500),
    measureFrom: exec.scenario.startTime + (RAMP_SECONDS + SETTLE_SECONDS) * 1000,
    cursorEveryMs: Number(__ENV.CURSOR_EVERY_MS ?? 100),
  });
}

export function handleSummary(data: Parameters<typeof summarize>[0]) {
  return summarize(data, __ENV.OUT ?? ".data/result-a.json");
}
