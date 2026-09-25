#!/usr/bin/env bash
# Two sync instances behind nginx, sharing Redis — natively, without Docker (the same
# topology as docker-compose.scale.yml). Uses apps/server/.env for the database and
# secrets; the instances listen on 4001 and 4002, the load balancer on 8080.
#
#   pnpm scale:local            # build, start everything, Ctrl-C stops it all
#
# Needs redis-server and nginx on PATH (see docs/scaling.md → "Tools").
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_DIR="${RUN_DIR:-$ROOT/.scale-run}"
LB_PORT="${LB_PORT:-8080}"
REDIS_PORT="${REDIS_PORT:-6379}"
PORTS=(4001 4002)
mkdir -p "$RUN_DIR/logs"
PIDS=()

cleanup() {
  echo "stopping…"
  for pid in "${PIDS[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Each instance holds up to ~2,000 sockets; nginx twice that.
ulimit -n 10240

# A previous run may still be draining (graceful shutdown flushes every room first).
for port in "${PORTS[@]}" "$LB_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is still in use (a previous run shutting down?); try again shortly"
    exit 1
  fi
done

for tool in redis-server redis-cli nginx; do
  command -v "$tool" >/dev/null || { echo "missing $tool on PATH (see docs/scaling.md)"; exit 1; }
done

if ! redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1; then
  redis-server --port "$REDIS_PORT" --save "" --appendonly no \
    --maxmemory-policy noeviction --logfile "$RUN_DIR/redis.log" &
  PIDS+=($!)
  sleep 0.5
fi

(cd "$ROOT" && pnpm --filter @whiteboard/server build >/dev/null)

EXTRA_ORIGINS="http://localhost:5173,http://localhost:5174,http://localhost:4173"
for i in 0 1; do
  port="${PORTS[$i]}"
  # --env-file never overrides variables already set here.
  # 2 instances × 6 connections stay under the Supabase session pooler's 15 per project.
  PORT="$port" INSTANCE_ID="server$((i + 1))" REDIS_URL="redis://127.0.0.1:$REDIS_PORT" \
    DATABASE_POOL_MAX="${DATABASE_POOL_MAX:-6}" \
    CORS_ALLOWED_ORIGINS="$EXTRA_ORIGINS" LOG_LEVEL="${LOG_LEVEL:-info}" \
    node --enable-source-maps --env-file="$ROOT/apps/server/.env" \
    "$ROOT/apps/server/dist/index.js" >"$RUN_DIR/server$((i + 1)).log" 2>&1 &
  PIDS+=($!)
  echo $! >"$RUN_DIR/server$((i + 1)).pid"
done

sed -e "s#\${UPSTREAM_1}#127.0.0.1:${PORTS[0]}#" -e "s#\${UPSTREAM_2}#127.0.0.1:${PORTS[1]}#" \
  -e "s#\${LISTEN_PORT}#$LB_PORT#" -e "s#\${RUN_DIR}#$RUN_DIR#g" \
  "$ROOT/infra/scale/nginx.conf.template" >"$RUN_DIR/nginx.conf"
nginx -p "$RUN_DIR" -c "$RUN_DIR/nginx.conf" -g "daemon off;" &
PIDS+=($!)
echo $! >"$RUN_DIR/nginx.pid.launcher"

for port in "${PORTS[@]}" "$LB_PORT"; do
  for _ in $(seq 1 100); do
    curl -fs "http://127.0.0.1:$port/readyz" >/dev/null 2>&1 && break
    sleep 0.2
  done
done
for i in 1 2; do
  if ! kill -0 "$(cat "$RUN_DIR/server$i.pid")" 2>/dev/null; then
    echo "server$i failed to start:"; tail -5 "$RUN_DIR/server$i.log"; exit 1
  fi
done
echo "ready: load balancer ws://127.0.0.1:$LB_PORT, instances :${PORTS[0]} :${PORTS[1]}"
echo "logs:  $RUN_DIR/server1.log $RUN_DIR/server2.log"
wait
