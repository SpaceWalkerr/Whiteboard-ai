// Independent latency probe (Node, not k6): two extra clients in one seeded room, each
// editing every 200 ms while the other times delivery. Run it next to a k6 test to tell
// server-side delay from load-generator delay:
//   pnpm --filter @whiteboard/loadtest probe [seconds] [seed file] [ws url]
import { readFileSync } from "node:fs";
import { WebSocket } from "ws";
import { encodeMapSet, findMarkers, marker, messageType, syncUpdateMessage } from "./codec";

interface Seed {
  wsUrl: string;
  origin: string;
  rooms: { boardId: string; members: { userId: string; ticket: string }[] }[];
}

const [, , secondsArg = "60", seedFile = ".data/seed-b.json", wsArg] = process.argv;
const seed = JSON.parse(readFileSync(seedFile, "utf8")) as Seed;
const room = seed.rooms[0];
if (!room || room.members.length < 2) throw new Error("seed needs a room with 2 members");
const url = `${wsArg ?? seed.wsUrl}/rooms/${room.boardId}`;
const samples: number[] = [];

function client(index: number, member: { ticket: string }): Promise<WebSocket> {
  const ws = new WebSocket(url, ["whiteboard.v1", `ticket.${member.ticket}`], {
    headers: { Origin: seed.origin },
  });
  ws.binaryType = "nodebuffer";
  ws.on("message", (data: Buffer) => {
    const now = Date.now();
    const bytes = new Uint8Array(data);
    if (messageType(bytes) !== 0) return;
    for (const seen of findMarkers(bytes)) {
      // Probe VUs are 900001/900002, far from k6's.
      if (seen.vu !== 900_000 + index && seen.vu > 900_000) samples.push(now - seen.sentAt);
    }
  });
  return new Promise((resolve, reject) => {
    ws.once("open", () => {
      resolve(ws);
    });
    ws.once("error", reject);
  });
}

const members = room.members.slice(0, 2);
const sockets = await Promise.all(members.map((m, i) => client(i + 1, m)));
let clock = 0;
let seq = 0;
const timer = setInterval(() => {
  for (const [i, ws] of sockets.entries()) {
    const vu = 900_000 + i + 1;
    seq += 1;
    ws.send(
      syncUpdateMessage(
        encodeMapSet({
          clientId: 0x20000000 + i,
          clock,
          rootName: "probe",
          key: `probe-${String(i)}`,
          value: marker(vu, seq, Date.now()),
        }),
      ),
    );
  }
  clock += 1;
}, 200);

await new Promise((resolve) => setTimeout(resolve, Number(secondsArg) * 1000));
clearInterval(timer);
for (const ws of sockets) ws.close();
samples.sort((a, b) => a - b);
const pct = (p: number) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))];
process.stdout.write(
  `probe: ${String(samples.length)} deliveries  p50 ${String(pct(0.5))} ms  ` +
    `p95 ${String(pct(0.95))} ms  p99 ${String(pct(0.99))} ms  max ${String(samples.at(-1))} ms\n`,
);
