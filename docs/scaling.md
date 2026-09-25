# Scaling the sync server (Phase 5)

apps/server runs as **2+ identical instances** behind Render's load balancer (no sticky
sessions). Two clients editing the same board may be connected to different instances; this
document explains how they still see each other, who persists each board, what happens when
an instance dies, and what we measured.

## Architecture

```mermaid
flowchart LR
  A[Browser A] -- "WSS /rooms/:id<br/>(room ticket)" --> LB
  B[Browser B] -- WSS --> LB
  LB["Load balancer<br/>(Render; nginx in the scale test)<br/>round-robin, no stickiness"]
  LB --> S1
  LB --> S2
  subgraph S1 [apps/server instance 1]
    R1["Room (Y.Doc + Awareness)<br/>clients: A"]
  end
  subgraph S2 [apps/server instance 2]
    R2["Room (Y.Doc + Awareness)<br/>clients: B"]
  end
  R1 <-- "PUBLISH / SUBSCRIBE<br/>wb:room:{boardId}" --> K[(Redis / Render Key Value)]
  R2 <-- " " --> K
  S1 -. "lease wb:lease:{boardId}<br/>(SET NX PX, renew, release)" .-> K
  R1 == "writer (lease holder):<br/>append + compact" ==> PG[(Supabase Postgres)]
  S2 -. "non-writer: reads on load;<br/>writes only to catch up" .-> PG
  S1 -. "revocations<br/>whiteboard:revocations" .-> K
```

- **Room channel.** Each instance that has a board open subscribes to `wb:room:{boardId}`
  and publishes what its own clients do: document updates, awareness (cursors/presence),
  and the writer's "persisted" acknowledgements. Messages are binary envelopes (version,
  sender instance id, kind, payload; `apps/server/src/cluster/envelope.ts`), validated on
  receipt; malformed ones are dropped and counted.
- **No echo loops.** An instance ignores messages carrying its own id (Redis delivers them
  back), and changes received from another instance are applied with a `REMOTE_ORIGIN`
  transaction origin: forwarded to local clients, persisted if this instance is the writer,
  but never published again. A test asserts one edit = exactly one publication.
- **Joining.** A room subscribes **before** it reads the board from Postgres, then asks the
  other instances for anything newer (`syncRequest` with its state vector → `syncReply`
  diff) and for their clients' presence. Messages arriving during the load are queued and
  applied after it.
- **Lost messages.** Pub/sub is fire-and-forget. Every room re-sends its state vector every
  `SYNC_RESYNC_MS` (15 s), and all rooms resync immediately after the Redis subscription
  reconnects; peers reply with whatever is missing (Yjs updates are idempotent).
- **Presence across instances.** A client id already held by a client on another instance
  can only be claimed by the same signed-in user (the same tab reconnecting after its
  instance died); anyone else is rejected (`awareness_spoofed`). Cursors of a dead
  instance's clients disappear after y-protocols' 30 s awareness timeout (or at once when
  their tab reconnects elsewhere and reclaims them).
- **Revocations** (Phase 4: member removed, link revoked, public off, board deleted) travel
  over `whiteboard:revocations`; each instance closes its matching sockets. Tested across
  two instances.

### Persistence ownership: one writer per room, idempotent writes as the safety net

We use **both** options from the phase brief, for different reasons:

1. **Single writer (efficiency + exact acknowledgements).** A Redis lease
   `wb:lease:{boardId}` (`SET NX PX 15000`, renewed every 5 s, compare-and-set renew/release
   in Lua) names the instance that persists the room. It writes every update (its own
   clients' and those relayed from other instances) and broadcasts "persisted" with the
   state vector it committed; other instances forward that to their clients. So each edit is
   written once, and **"Saved" still means committed to Postgres**, whichever instance the
   client is on.
2. **Idempotent writes (correctness never depends on the lease).** Seqs are allocated by
   the database (`boards.last_seq`, migration 0004) in the same statement as the insert,
   under the board row's lock, and Yjs updates can be applied twice. So two writers (a
   split brain: a lease expiring under a GC pause, or Redis unreachable — then every
   instance writes, "fail open") only produce duplicate rows, never clashing seqs or a
   wrong board. Tested: forced split brain; 12 concurrent appends + a compaction.

**When the writer goes away:**

- _Graceful (SIGTERM, eviction):_ it flushes, snapshots, releases the lease and announces
  `leaseReleased`; another instance with the room takes over at once.
- _Crash (kill -9):_ the lease expires within `SYNC_LEASE_TTL_MS`; the next instance to
  claim it first writes a **catch-up update**: it rebuilds the stored board and applies its
  own document to it — whatever that changes (new content **and** deletions) is exactly what
  the database lacks. Then it acknowledges.
- _A non-writer leaving a room_ does the same catch-up before dropping it, so no instance
  ever leaves a room holding edits that aren't stored.

**Guarantee (unchanged from Phase 3):** an edit shown as **Saved** survives any instance
failure. An unsaved edit lives in the browser (memory + IndexedDB) and is re-sent on
reconnect.

```mermaid
sequenceDiagram
  participant A as Browser A
  participant LB as Load balancer
  participant S1 as Instance 1 (writer)
  participant R as Redis
  participant S2 as Instance 2
  participant PG as Postgres
  A->>LB: edit
  LB->>S1: edit
  S1->>R: PUBLISH update
  R->>S2: update → Browser B
  Note over S1: kill -9 (unsaved edits in flight)
  A-->>LB: socket closed → reconnect
  LB->>S2: (instance 1 refused) connect
  A->>S2: sync step: re-sends unsaved edits
  Note over S2: lease expires (TTL)
  S2->>R: SET wb:lease NX → acquired
  S2->>PG: catch-up write (what the DB lacks)
  S2->>A: persisted → "Saved"
```

## Tests (all in `pnpm test`)

| Test                               | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cluster.redis.test.ts` (12)       | A on instance 1, B on instance 2: edits both ways + concurrent conflicts converge; cursors both ways, newcomer sees them, leaving removes them at once; late joiner gets not-yet-persisted edits; no echo; lost pub/sub repaired by resync; exactly one writer and B (non-writer) gets "Saved"; handover on writer eviction (no TTL wait); writer dies with uncommitted edits → takeover + catch-up write, same tab reclaims its cursor; split brain stays exact; cross-instance cursor spoofing rejected; revocation closes a socket on the other instance; malformed channel messages ignored |
| `failover.pg.test.ts` (2)          | Two **real processes**, real Postgres + Redis, round-robin TCP proxy: **kill -9** the writer (A's instance) mid-edit → A reconnects to instance 2 in **~210–240 ms**, everything saved **~3.9 s** later (TTL 3 s in the test), **375/375** edits stored; **SIGTERM** → saved on the other instance in **0.7–1.1 s**                                                                                                                                                                                                                                                                             |
| `lease-envelope.redis.test.ts` (5) | lease exclusive, expires, renewal, holder-only release; envelope round-trip and malformed input                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `persistence.pg.test.ts` (+1)      | 12 concurrent appends from 2 repositories + a compaction → unique contiguous seqs, exact board                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `limitedWrites.test.ts` (2)        | write concurrency cap, slots released on failure, reads never limited                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## Measurements

### Setup (all on one machine — read the caveats)

- **Machine:** Apple silicon Mac, 8 cores, 8 GB RAM, macOS 26.6; Node 22.13.
- **Stack:** `pnpm scale:local` — 2 instances (`DATABASE_POOL_MAX=6` each), nginx 1.28
  round-robin (no stickiness) on :8080, Redis 7.4 — native builds, **same topology as
  `docker-compose.scale.yml`** (Docker isn't installed on the dev machine, so the compose file
  itself has not been run yet).
- **Database:** the Supabase **dev** project (ap-southeast-1) through the session pooler,
  **76 ms per round trip** (p50, measured) from the dev machine in India. In production
  Render and Supabase are both in Singapore (~1–2 ms).
- **Load generators:** k6 2.3.0 (`loadtest/src/k6/*`) and, for 2,000 connections, a Node
  generator with the identical traffic model and codec (`loadtest/src/node-load.ts`, 4
  processes) — see "k6 at 2,000" below.
- **Traffic:** real Yjs updates (byte-identical to `Y.Map#set`, checked against Yjs) and real
  presence, through the normal ticket + database access check on every upgrade. Every edit
  carries its send time; receivers compute **edit → visible on another client**, and
  sequence gaps count **missed** edits. Latency is measured over the steady state (after the
  ramp and a settle period); connection setup is reported separately.
- **CPU** = share of one core, averaged over the busy seconds (`loadtest/sample.sh`, from
  cumulative CPU time); **memory** = peak RSS.

### (a) 50 editors in one room — k6, through nginx, 2 instances

Each editor: cursor at 10 Hz, one edit every 500 ms. 10 s ramp, 10 s settle, 120 s hold.

| Metric                          | Result                                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Edit propagation (steady state) | **p50 3 ms · p95 9 ms · p99 14 ms · max 72 ms**                                                           |
| Deliveries / missed             | 587,801 / **0**                                                                                           |
| Connections                     | 50/50 (25 per instance), 0 errors, 0 unexpected closes                                                    |
| Connection setup                | p50 176 ms · p95 552 ms (one access query to the remote DB)                                               |
| "Saved" ack (edit → committed)  | p50 312 ms · p95 1,553 ms (remote DB — see bottlenecks)                                                   |
| CPU / memory                    | instance 1: 13 % avg (22 % peak), 150 MB · instance 2: 12 % (19 %), 153 MB · Redis 6 %, 3 MB · nginx 20 % |
| Event-loop lag p99              | 12 ms                                                                                                     |

### (b) 2,000 connections across 200 rooms (10 per room)

Each tab: cursor at 2 Hz, one edit every 5 s (≈ 4,000 presence + 400 edit messages/s in,
fan-out ×9). 120 s ramp (~17 connections/s), 15 s settle, 120 s hold. Node generator.

| Metric                                | 2 instances via nginx                                | **1 instance, all 2,000**                            |
| ------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| Edit propagation (steady state)       | **p50 1 · p95 8 · p99 12 · max 32 ms** (n = 431,946) | **p50 1 · p95 7 · p99 13 · max 37 ms** (n = 431,955) |
| Connections opened / failed / dropped | 2,000 / 0 / 0                                        | 2,000 / 0 / 0                                        |
| Edits sent / missed                   | 76,879 / **0**                                       | 75,366 / **0**                                       |
| Connection setup                      | p50 161 ms · p95 1.2 s                               | p50 3.2 s · p95 9.4 s                                |
| "Saved" ack                           | p50 7.9 s · p95 10.4 s                               | p50 16.7 s · p95 21.9 s                              |
| CPU (one core)                        | 30 % avg / 48 % peak each                            | **38 % avg / 54 % peak**                             |
| Memory (RSS)                          | 151 / 150 MB                                         | **184 MB** (heap 81 MB) ≈ 40 KB per connection       |
| Redis / nginx CPU                     | 19 % / 42 %                                          | 21 % / –                                             |
| Event-loop lag p99                    | 13 ms                                                | 15 ms                                                |

k6 cross-check: the same k6 scenario at **500 connections**: p50 1 ms · p95 71 ms · p99
149 ms, 0 errors, 0 missed.

### Against SPEC.md targets

| Target                                                              | Result                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edit → visible on another client **p95 < 150 ms** within one region | ✅ **7–9 ms p95** through the sync tier (50 editors; 2,000 connections). Measured on one machine, so clients' own network legs are excluded: in production add each client's round trip to Singapore (a few ms to tens of ms within the region).        |
| **50 concurrent editors** in one board                              | ✅ 50 editors, 0 missed, 13 % of a core per instance                                                                                                                                                                                                    |
| **2,000 concurrent connections per sync instance**                  | ✅ for the sync tier: 2,000 on one instance at 38 % of one core, 184 MB, p95 7 ms. ⚠️ Connection setup (p95 9.4 s) and "Saved" (p50 16.7 s) were **database-bound here** — see bottleneck 5; to be re-measured next to the database (Phase 13 staging). |
| Zero data loss on restart                                           | ✅ kill -9 failover: 375/375 stored; SIGTERM handover; Phase 3 crash test 200/200                                                                                                                                                                       |

## Bottlenecks found (and what we changed)

1. **Supabase session-pooler connection cap.** The first 2,000-connection run failed badly:
   204 upgrades rejected, 150 room loads failed (close 1011), 325 write retries — all
   `EMAXCONNSESSION: max clients reached … pool_size: 15`. Two instances × 10 connections =
   20 > 15. **Fix:** `DATABASE_POOL_MAX` (6 per instance in `render.yaml`: 2 × 6 + headroom
   for migrations/cron ≤ 15). Rule: _instances × DATABASE_POOL_MAX + 3 ≤ pooler pool size_;
   adding instances means lowering it or raising Supabase compute.
2. **Writes starved reads.** With every connection busy writing batches, socket
   authorization and room loads queued behind them for tens of seconds; clients' edits wait
   in a loading room's buffer, which showed up as 30–70 s "propagation". **Fix:**
   `LimitedWritesRepository` — persistence may use at most half the pool; under load a
   room's next batch just grows.
3. **Append took four round trips** (BEGIN, UPDATE, INSERT, COMMIT). **Fix:** one statement
   (CTE reserving the seq range + insert). Scenario (a) "Saved" p50 went from 842 ms to
   312 ms against the remote database.
4. **The load generator.** k6 with 2,000 message-heavy WebSocket VUs on the 8 GB dev Mac
   falls behind: it sent 4,565 of ~54,000 planned edits and reported minutes of "latency"
   while the servers idled at 6 % CPU — an independent Node probe in the same run saw p50
   1 ms. k6 is accurate up to ~500 connections here. **For (b) with k6, run it from separate
   machine(s)** (or k6 distributed); the Node generator gives the 2,000 numbers above.
5. **Database round trips from the dev machine (still open, environment-specific).**
   Connection setup (1 query) and "Saved" (≥ 1 statement per batch, 3 write slots per
   instance) are bound by the 76 ms India→Singapore round trip: 3 slots ÷ ~0.1 s ≈ 30
   transactions/s per instance, while 200 active rooms want up to ~400/s, so batches wait
   (and grow). Next to the database (~1–2 ms) the same 3 slots give roughly 1,000+
   transactions/s, so "Saved" should be ≈ the 50 ms batching window + a few ms, and setup a
   few ms. **To verify** with this load test against Render staging in Phase 13. If it does
   not hold, in order: write several rooms' batches in one statement; load a board in one
   query instead of three; raise Supabase compute (bigger pooler) and `DATABASE_POOL_MAX`.
6. **Redis traffic is dominated by cursors.** Every presence change is published even when
   no other instance has the room (single-instance run: Redis at 21 % of a core for 2,000
   connections). Redis is single-threaded, so ~10× this load would saturate it. **Next
   steps when needed:** coalesce presence per room per tick (e.g. 50 ms) and skip publishing
   for rooms no other instance holds.

Other observations: the local nginx used 42 % of a core at 2,000 connections (Render's load
balancer replaces it in production); the periodic resync costs one small message per room
per instance every 15 s; memory is ~40 KB per connection.

## Reproducing

**Tools** (only for scale/load tests; `pnpm dev` needs none of them):

- _With Docker:_ `pnpm scale:up` (`docker-compose.scale.yml`: Redis, `supabase/postgres`
  migrated, `server1`/`server2`, nginx on :8080, instances on :4001/:4002). Seed against
  that database with
  `DATABASE_URL=postgresql://postgres:postgres@localhost:54322/postgres ROOM_TICKET_SECRET=scale-test-ticket-secret-0123456789abcdef pnpm load:seed a`.
- _Without Docker (how the numbers above were taken):_ `redis-server`, `nginx` and `k6` on
  `PATH` (built/downloaded into `~/.local/bin`: Redis 7.4.6 and nginx 1.28 from source, k6
  release binary), then `pnpm scale:local` (uses `apps/server/.env`, i.e. the dev Supabase
  project; the load-test data is removed with `pnpm load:seed cleanup`).

**Runs** (seed right before each run — tickets are valid for 5 minutes):

```bash
pnpm load:seed a
pnpm --filter @whiteboard/loadtest load:a                      # 50 editors (k6)
pnpm load:seed b
pnpm --filter @whiteboard/loadtest load:b                      # 2,000 connections (k6; use a separate machine)
pnpm --filter @whiteboard/loadtest node-load 2000              # same traffic, Node generator
pnpm load:seed b ws://127.0.0.1:4001 && pnpm --filter @whiteboard/loadtest node-load 2000 -- --url ws://127.0.0.1:4001   # one instance
bash loadtest/sample.sh 270 loadtest/.data/stats.csv &          # CPU/memory while a run is going
node loadtest/summarize-stats.mjs loadtest/.data/stats.csv
pnpm load:seed cleanup
```

Results land in `loadtest/.data/` (git-ignored).
