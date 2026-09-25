import { SharedArray } from "k6/data";
import { Counter, Rate, Trend } from "k6/metrics";
import { clearInterval, setInterval, setTimeout } from "k6/timers";
import { WebSocket } from "k6/websockets";
import {
  awarenessMessage,
  encodeMapSet,
  findMarkers,
  marker,
  messageType,
  persistedClock,
  presence,
  syncUpdateMessage,
} from "../codec";

/** Edit sent by one client → visible to another client (the SPEC target: p95 < 150 ms). */
export const propagation = new Trend("edit_propagation_ms", true);
/** Edit sent → the server says it is committed to Postgres ("Saved"). */
export const persistAck = new Trend("persist_ack_ms", true);
export const connected = new Rate("ws_connected");
/** new WebSocket → open: includes the ticket check and room access query on the upgrade. */
export const connectTime = new Trend("ws_connect_ms", true);
export const wsErrors = new Counter("ws_errors");
export const unexpectedCloses = new Counter("ws_unexpected_closes");
export const editsSent = new Counter("edits_sent");
export const editsReceived = new Counter("edits_received");
/** Gaps in another tab's edit sequence as seen by this tab: edits that never arrived. */
export const editsMissed = new Counter("edits_missed");

/** Percentiles shown in the summary (k6's default omits p99). */
export const TREND_STATS = ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"];

/** Written by the seed script (apps/server/scripts/loadtest-seed.ts). */
export interface Seed {
  wsUrl: string;
  origin: string;
  rooms: { boardId: string; members: { userId: string; ticket: string }[] }[];
}

/** Reads the seed once and shares it between all VUs (init context only). */
export function loadSeed(path: string): Seed {
  const [seed] = new SharedArray<Seed>("seed", () => [JSON.parse(open(path)) as Seed]);
  if (!seed) throw new Error(`no seed in ${path}`);
  return seed;
}

export interface SessionOptions {
  wsUrl: string;
  origin: string;
  boardId: string;
  userId: string;
  ticket: string;
  vu: number;
  /** Wait before connecting (spreads connections over a ramp-up). */
  startDelayMs: number;
  /** How long to stay connected once open. */
  holdMs: number;
  editEveryMs: number;
  cursorEveryMs: number;
  /**
   * Epoch ms from which propagation and loss are measured: steady state, after every tab
   * has connected and every room has loaded (the ramp is measured by ws_connect_ms).
   */
  measureFrom: number;
}

const CLIENT_ID_BASE = 0x10000000;

/**
 * One simulated browser tab: connects with its room ticket, moves its cursor and edits one
 * shape at fixed rates, and measures how long other tabs' edits take to reach it.
 */
export function runSession(options: SessionOptions): void {
  setTimeout(() => {
    connect(options);
  }, options.startDelayMs);
}

function connect(options: SessionOptions): void {
  const { vu } = options;
  // Unique per VU. Every run seeds fresh boards, so ids never meet an earlier run's.
  const clientId = CLIENT_ID_BASE + vu;
  let clock = 0;
  let awarenessClock = 0;
  let seq = 0;
  let closing = false;
  let opened = false;
  const unacked = new Map<number, number>(); // clock → sent at
  const lastSeqFrom = new Map<number, number>(); // other VU → last edit seq seen
  const timers: number[] = [];

  const connectStarted = Date.now();
  const ws = new WebSocket(`${options.wsUrl}/rooms/${options.boardId}`, null, {
    headers: {
      Origin: options.origin,
      // Same as the browser: the ticket travels as an offered subprotocol, never in the URL.
      "Sec-WebSocket-Protocol": `whiteboard.v1, ticket.${options.ticket}`,
    },
  });
  ws.binaryType = "arraybuffer";

  const send = (bytes: Uint8Array) => {
    // The codec returns fresh, exactly-sized arrays.
    ws.send(new Uint8Array(bytes));
  };
  const sendCursor = () => {
    awarenessClock += 1;
    const x = Math.round(Math.random() * 2000);
    const y = Math.round(Math.random() * 1200);
    send(awarenessMessage(clientId, awarenessClock, presence(options.userId, `Load ${vu}`, x, y)));
  };

  ws.onopen = () => {
    opened = true;
    connected.add(true);
    connectTime.add(Date.now() - connectStarted);
    sendCursor();
    timers.push(setInterval(sendCursor, options.cursorEveryMs));
    timers.push(
      setInterval(() => {
        const sentAt = Date.now();
        seq += 1;
        const update = encodeMapSet({
          clientId,
          clock,
          rootName: "loadtest",
          key: `vu-${vu}`,
          value: marker(vu, seq, sentAt),
        });
        unacked.set(clock, sentAt);
        clock += 1;
        send(syncUpdateMessage(update));
        editsSent.add(1);
      }, options.editEveryMs),
    );
    setTimeout(() => {
      closing = true;
      for (const timer of timers) clearInterval(timer);
      ws.close();
    }, options.holdMs);
  };

  ws.onmessage = (event) => {
    const now = Date.now();
    const data: unknown = event?.data;
    if (!(data instanceof ArrayBuffer)) return;
    const bytes = new Uint8Array(data);
    const type = messageType(bytes);
    if (type === 0) {
      for (const seen of findMarkers(bytes)) {
        if (seen.vu === vu || seen.sentAt < options.measureFrom) continue;
        propagation.add(now - seen.sentAt);
        editsReceived.add(1);
        const last = lastSeqFrom.get(seen.vu);
        if (last !== undefined && seen.seq > last + 1) editsMissed.add(seen.seq - last - 1);
        lastSeqFrom.set(seen.vu, Math.max(last ?? 0, seen.seq));
      }
    } else if (type === 2) {
      const committed = persistedClock(bytes, clientId);
      if (committed === null) return;
      for (const [editClock, sentAt] of unacked) {
        if (editClock >= committed) continue;
        if (sentAt >= options.measureFrom) persistAck.add(now - sentAt);
        unacked.delete(editClock);
      }
    }
  };

  ws.onerror = () => {
    wsErrors.add(1);
  };

  ws.onclose = () => {
    for (const timer of timers) clearInterval(timer);
    if (closing) return;
    if (!opened) connected.add(false);
    else unexpectedCloses.add(1);
  };
}

/** Compact end-of-run report; the full data goes to a JSON file for docs/scaling.md. */
export function summarize(
  data: { metrics: Record<string, { values: Record<string, number> } | undefined> },
  outFile: string,
): Record<string, string> {
  const value = (metric: string, stat: string) => data.metrics[metric]?.values[stat] ?? NaN;
  const lines = [
    `edit propagation  p50 ${value("edit_propagation_ms", "med").toFixed(1)} ms  ` +
      `p95 ${value("edit_propagation_ms", "p(95)").toFixed(1)} ms  ` +
      `p99 ${value("edit_propagation_ms", "p(99)").toFixed(1)} ms  ` +
      `max ${value("edit_propagation_ms", "max").toFixed(0)} ms`,
    `persist ack       p50 ${value("persist_ack_ms", "med").toFixed(0)} ms  ` +
      `p95 ${value("persist_ack_ms", "p(95)").toFixed(0)} ms`,
    `connect           p50 ${value("ws_connect_ms", "med").toFixed(0)} ms  ` +
      `p95 ${value("ws_connect_ms", "p(95)").toFixed(0)} ms  ` +
      `max ${value("ws_connect_ms", "max").toFixed(0)} ms`,
    `connected ${(value("ws_connected", "rate") * 100).toFixed(2)}%  ` +
      `errors ${value("ws_errors", "count") || 0}  ` +
      `unexpected closes ${value("ws_unexpected_closes", "count") || 0}`,
    `edits sent ${value("edits_sent", "count")}  deliveries (steady state) ${value("edits_received", "count")}  ` +
      `missed ${value("edits_missed", "count") || 0}`,
  ];
  return { stdout: `\n${lines.join("\n")}\n\n`, [outFile]: JSON.stringify(data, null, 2) };
}
