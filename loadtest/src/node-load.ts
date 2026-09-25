// Node load generator: the same traffic model and measurements as the k6 scenarios, spread
// over several worker processes. Used where one machine can't run enough k6 VUs (k6 on the
// 8 GB dev Mac falls behind above ~500 message-heavy WebSockets; see docs/scaling.md).
//
//   pnpm --filter @whiteboard/loadtest node-load <connections> [options]
//     --seed .data/seed-b.json  --url ws://127.0.0.1:8080  --workers 4
//     --ramp 120 --settle 15 --hold 120 --edit-every 5000 --cursor-every 500
//     --out .data/node-load-b.json
import { fork } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { WebSocket } from "ws";
import {
  awarenessMessage,
  encodeMapSet,
  findMarkers,
  marker,
  messageType,
  persistedClock,
  presence,
  syncUpdateMessage,
} from "./codec";

interface Seed {
  wsUrl: string;
  origin: string;
  rooms: { boardId: string; members: { userId: string; ticket: string }[] }[];
}

interface Plan {
  seedFile: string;
  url: string;
  connections: number;
  /** Epoch ms at which the ramp starts (shared by all workers). */
  startAt: number;
  rampMs: number;
  settleMs: number;
  holdMs: number;
  editEveryMs: number;
  cursorEveryMs: number;
}

interface WorkerResult {
  propagation: number[];
  persistAck: number[];
  connect: number[];
  opened: number;
  failed: number;
  unexpectedCloses: number;
  editsSent: number;
  missed: number;
}

const CLIENT_ID_BASE = 0x30000000;

function runConnection(plan: Plan, seed: Seed, vu: number, result: WorkerResult) {
  const room = seed.rooms[(vu - 1) % seed.rooms.length];
  const member = room?.members[Math.floor((vu - 1) / seed.rooms.length) % room.members.length];
  if (!room || !member) throw new Error("seed has no room/member for this connection");
  const measureFrom = plan.startAt + plan.rampMs + plan.settleMs;
  const endAt = measureFrom + plan.holdMs;
  const startDelay = plan.startAt + ((vu - 1) / plan.connections) * plan.rampMs - Date.now();

  setTimeout(
    () => {
      const clientId = CLIENT_ID_BASE + vu;
      let clock = 0;
      let awarenessClock = 0;
      let seq = 0;
      let closing = false;
      const unacked = new Map<number, number>();
      const lastSeqFrom = new Map<number, number>();
      const timers: NodeJS.Timeout[] = [];
      const started = Date.now();
      const ws = new WebSocket(
        `${plan.url}/rooms/${room.boardId}`,
        ["whiteboard.v1", `ticket.${member.ticket}`],
        { headers: { Origin: seed.origin } },
      );

      ws.on("open", () => {
        result.opened += 1;
        result.connect.push(Date.now() - started);
        const sendCursor = () => {
          awarenessClock += 1;
          ws.send(
            awarenessMessage(
              clientId,
              awarenessClock,
              presence(
                member.userId,
                `Load ${String(vu)}`,
                Math.random() * 2000,
                Math.random() * 1200,
              ),
            ),
          );
        };
        sendCursor();
        timers.push(setInterval(sendCursor, plan.cursorEveryMs));
        timers.push(
          setInterval(() => {
            const sentAt = Date.now();
            seq += 1;
            unacked.set(clock, sentAt);
            ws.send(
              syncUpdateMessage(
                encodeMapSet({
                  clientId,
                  clock,
                  rootName: "loadtest",
                  key: `vu-${String(vu)}`,
                  value: marker(vu, seq, sentAt),
                }),
              ),
            );
            clock += 1;
            result.editsSent += 1;
          }, plan.editEveryMs),
        );
        setTimeout(() => {
          closing = true;
          for (const timer of timers) clearInterval(timer);
          ws.close();
        }, endAt - Date.now());
      });

      ws.on("message", (data: Buffer) => {
        const now = Date.now();
        const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const type = messageType(bytes);
        if (type === 0) {
          for (const seen of findMarkers(bytes)) {
            if (seen.vu === vu || seen.sentAt < measureFrom) continue;
            result.propagation.push(now - seen.sentAt);
            const last = lastSeqFrom.get(seen.vu);
            if (last !== undefined && seen.seq > last + 1) result.missed += seen.seq - last - 1;
            lastSeqFrom.set(seen.vu, Math.max(last ?? 0, seen.seq));
          }
        } else if (type === 2) {
          const committed = persistedClock(bytes, clientId);
          if (committed === null) return;
          for (const [editClock, sentAt] of unacked) {
            if (editClock >= committed) continue;
            if (sentAt >= measureFrom) result.persistAck.push(now - sentAt);
            unacked.delete(editClock);
          }
        }
      });

      ws.on("error", () => {
        if (ws.readyState !== WebSocket.OPEN) result.failed += 1;
      });
      ws.on("close", () => {
        for (const timer of timers) clearInterval(timer);
        if (!closing && ws.readyState !== WebSocket.CONNECTING) result.unexpectedCloses += 1;
      });
    },
    Math.max(0, startDelay),
  );
}

async function worker(plan: Plan, index: number, workers: number): Promise<void> {
  const seed = JSON.parse(readFileSync(plan.seedFile, "utf8")) as Seed;
  const result: WorkerResult = {
    propagation: [],
    persistAck: [],
    connect: [],
    opened: 0,
    failed: 0,
    unexpectedCloses: 0,
    editsSent: 0,
    missed: 0,
  };
  for (let vu = index + 1; vu <= plan.connections; vu += workers)
    runConnection(plan, seed, vu, result);
  const endAt = plan.startAt + plan.rampMs + plan.settleMs + plan.holdMs;
  await new Promise((resolve) => setTimeout(resolve, endAt - Date.now() + 3_000));
  // Exit only once the (large) result has been handed to the parent.
  process.send?.(result, () => process.exit(0));
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? NaN;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      seed: { type: "string", default: ".data/seed-b.json" },
      url: { type: "string" },
      workers: { type: "string", default: "4" },
      ramp: { type: "string", default: "120" },
      settle: { type: "string", default: "15" },
      hold: { type: "string", default: "120" },
      "edit-every": { type: "string", default: "5000" },
      "cursor-every": { type: "string", default: "500" },
      out: { type: "string", default: ".data/node-load.json" },
      worker: { type: "string" },
      plan: { type: "string" },
    },
  });

  if (values.worker !== undefined && values.plan !== undefined) {
    const [index = 0, workers = 1] = values.worker.split("/").map(Number);
    await worker(JSON.parse(values.plan) as Plan, index, workers);
    return;
  }

  const seed = JSON.parse(readFileSync(values.seed, "utf8")) as Seed;
  const workers = Number(values.workers);
  const plan: Plan = {
    seedFile: values.seed,
    url: values.url ?? seed.wsUrl,
    connections: Number(positionals[0] ?? 2000),
    startAt: Date.now() + 2_000,
    rampMs: Number(values.ramp) * 1000,
    settleMs: Number(values.settle) * 1000,
    holdMs: Number(values.hold) * 1000,
    editEveryMs: Number(values["edit-every"]),
    cursorEveryMs: Number(values["cursor-every"]),
  };
  const self = fileURLToPath(import.meta.url);
  const results = await Promise.all(
    Array.from(
      { length: workers },
      (_, i) =>
        new Promise<WorkerResult>((resolve, reject) => {
          const child = fork(
            self,
            [`--worker=${String(i)}/${String(workers)}`, `--plan=${JSON.stringify(plan)}`],
            {
              execArgv: ["--import", "tsx"],
            },
          );
          child.once("message", (message) => {
            resolve(message as WorkerResult);
          });
          child.once("error", reject);
        }),
    ),
  );

  const merged = (key: "propagation" | "persistAck" | "connect") =>
    results.flatMap((r) => r[key]).sort((a, b) => a - b);
  const sum = (key: "opened" | "failed" | "unexpectedCloses" | "editsSent" | "missed") =>
    results.reduce((total, r) => total + r[key], 0);
  const stats = (sorted: number[]) => ({
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) ?? NaN,
  });
  const summary = {
    plan: { ...plan, seedFile: undefined },
    propagation: stats(merged("propagation")),
    persistAck: stats(merged("persistAck")),
    connect: stats(merged("connect")),
    opened: sum("opened"),
    failed: sum("failed"),
    unexpectedCloses: sum("unexpectedCloses"),
    editsSent: sum("editsSent"),
    missed: sum("missed"),
  };
  writeFileSync(values.out, JSON.stringify(summary, null, 2));
  const line = (name: string, s: ReturnType<typeof stats>) =>
    `${name.padEnd(17)} p50 ${String(s.p50)} ms  p95 ${String(s.p95)} ms  p99 ${String(s.p99)} ms  max ${String(s.max)} ms  (n=${String(s.count)})`;
  process.stdout.write(
    [
      line("edit propagation", summary.propagation),
      line("persist ack", summary.persistAck),
      line("connect", summary.connect),
      `opened ${String(summary.opened)}/${String(plan.connections)}  failed ${String(summary.failed)}  ` +
        `unexpected closes ${String(summary.unexpectedCloses)}  edits sent ${String(summary.editsSent)}  ` +
        `missed ${String(summary.missed)}`,
    ].join("\n") + "\n",
  );
}

await main();
