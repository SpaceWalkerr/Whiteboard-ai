#!/usr/bin/env bash
# Samples cumulative CPU seconds and resident memory (MB) of the scale stack's processes once
# a second while a load test runs:  bash sample.sh <seconds> <out.csv>
# Summarise with: node summarize-stats.mjs <out.csv>
# Reads the pids written by infra/scale/run-local.sh. (With Docker: use `docker stats`.)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN_DIR="${RUN_DIR:-$ROOT/.scale-run}"
SECONDS_TO_RUN="${1:-180}"
OUT="${2:-$ROOT/loadtest/.data/stats.csv}"
S1=$(cat "$RUN_DIR/server1.pid")
S2=$(cat "$RUN_DIR/server2.pid")
REDIS=$(redis-cli info server | awk -F: '/^process_id/ {print $2}' | tr -d '\r')
NGINX_MASTER=$(cat "$RUN_DIR/nginx.pid")

# "cpu_seconds,rss_mb" summed over the given pids. ps prints cputime as [[hh:]mm:]ss.ss.
usage() {
  ps -o time=,rss= -p "$(echo "$@" | tr ' ' ',')" 2>/dev/null | awk '
    { n = split($1, p, ":"); s = 0; for (i = 1; i <= n; i++) s = s * 60 + p[i]; cpu += s; mem += $2 }
    END { printf "%.2f,%d", cpu, mem / 1024 }'
}

echo "t,server1_cpu_s,server1_mb,server2_cpu_s,server2_mb,redis_cpu_s,redis_mb,nginx_cpu_s,nginx_mb" >"$OUT"
for t in $(seq 1 "$SECONDS_TO_RUN"); do
  NGINX_WORKERS=$(pgrep -P "$NGINX_MASTER" | tr '\n' ' ')
  echo "$t,$(usage "$S1"),$(usage "$S2"),$(usage "$REDIS"),$(usage $NGINX_WORKERS)" >>"$OUT"
  sleep 1
done
