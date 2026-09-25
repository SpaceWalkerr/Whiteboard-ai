// Turns sample.sh output into average/peak CPU (cores) and peak memory per process, over the
// seconds where the servers were busy (skips idle lead-in and tail).
import { readFileSync } from "node:fs";

const [, , file = ".data/stats.csv"] = process.argv;
const [header, ...lines] = readFileSync(file, "utf8").trim().split("\n");
const columns = header.split(",");
const rows = lines.map((line) => line.split(",").map(Number));
const names = ["server1", "server2", "redis", "nginx"];

const perSecond = rows.slice(1).map((row, i) =>
  names.map((name) => {
    const c = columns.indexOf(`${name}_cpu_s`);
    return (row[c] - rows[i][c]) / (row[0] - rows[i][0]);
  }),
);
const busy = perSecond
  .map((cores, i) => ({ cores, row: rows[i + 1] }))
  .filter(({ cores }) => cores[0] + cores[1] > 0.05);

for (const [n, name] of names.entries()) {
  const cores = busy.map((b) => b.cores[n]);
  const mem = rows.map((row) => row[columns.indexOf(`${name}_mb`)]);
  const avg = cores.reduce((a, b) => a + b, 0) / Math.max(1, cores.length);
  process.stdout.write(
    `${name.padEnd(8)} cpu avg ${(avg * 100).toFixed(0).padStart(4)}%  ` +
      `peak ${(Math.max(...cores) * 100).toFixed(0).padStart(4)}%  ` +
      `rss peak ${Math.max(...mem)} MB  (busy seconds: ${cores.length})\n`,
  );
}
