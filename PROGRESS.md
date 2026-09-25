# Progress

## Current phase

Phase 7 — AI design review: implemented, awaiting manual verification (and a first eval run
with a real `ANTHROPIC_API_KEY`). Built on top of Phase 6, which is also still uncommitted
(implemented, awaiting manual verification). Phases 0–5 committed.

## Done

### Phase 0 — Foundation (repo, tooling, CI)

- pnpm workspaces + Turborepo monorepo: `apps/web`, `apps/server`, `packages/shared`,
  `packages/graph`, `packages/config`. Shared dependency versions pinned once via the pnpm catalog.
- TypeScript strict everywhere (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`),
  type-aware ESLint (typescript-eslint `strictTypeChecked`, react-hooks, jsx-a11y strict),
  Prettier, husky + lint-staged pre-commit.
- `packages/shared/src/env`: `loadEnv(schema, source)` + `serverEnvSchema` / `webEnvSchema`.
  Errors name every bad variable and never echo values. Server exits 1 at boot; web build fails;
  a web bundle built without env shows a "Configuration error" page.
- Drizzle in `packages/shared/src/db`: `profiles` table (PK → `auth.users.id`, cascade delete),
  RLS enabled, migration `0000_create_profiles.sql`. `pnpm db:migrate` applies migrations.
- RLS guard test (`packages/shared/test/rls.test.ts`): applies all migrations to a real database,
  fails if any `public` table has RLS off or any policy targets anon/authenticated/public.
- `apps/server`: Fastify + `ws` on one port. `/healthz` (liveness), `/readyz` (Postgres
  `select 1` + Redis `PING`, 1 s timeout each, 200/503). pino JSON logs with header redaction,
  CORS allowlist + anchored preview pattern, typed errors with user-safe messages, WebSocket
  upgrade on `/sync` that enforces Origin and refuses everything else with 401 until Phase 2,
  graceful shutdown (WS close 1012 → HTTP → Redis → Postgres, 25 s hard deadline).
- `apps/web`: Vite + React 19 + React Router 7 + Tailwind v4 + shadcn/ui (Button, Card) +
  TanStack Query. Home page calls `/healthz` and shows the result; SPA 404 page; `vercel.json`
  rewrites non-file routes to `index.html`.
- Tests: Vitest in every package (config presets, env loader, RLS, server routes/CORS/readiness
  with real clients against a dead port/WS upgrade/shutdown/boot failure, graph, web
  HealthStatus). Playwright smoke test (home page reaches API; SPA fallback).
- Local setup: no Docker. Development uses a hosted Supabase dev project (`DATABASE_URL` =
  session pooler URL); Redis is optional outside production. `pnpm dev` runs migrations then
  web + server.
- `render.yaml` Blueprint stub (singapore, starter plan, 2 instances, `/readyz`, Key Value
  `noeviction` in the same region). GitHub Actions CI: format check, lint, typecheck, build;
  tests against a `supabase/postgres` service container; Playwright smoke with browser cache.
- README with prerequisites, one-time setup, commands and layout.

### Phase 1 — Canvas editor (single user, Yjs-backed)

- `packages/shared/src/board`: zod schemas for every shape (rectangle, ellipse, text, sticky,
  freehand, arrow, and the 12 system-design shapes from SPEC.md, with database engine/role and
  queue mode), `BoardStore` (typed Y.Doc wrapper: create/update/delete/transact/reorder,
  validated reads and writes, snapshots that keep unchanged shapes referentially stable),
  `BoardHistory` (Y.UndoManager limited to the local origin, explicit gesture steps), clipboard
  format with id/group/arrow remapping, fractional z-order.
- `apps/web` `/board/local` (lazy-loaded route, linked from the home page): react-konva canvas
  with dotted grid, pan (Space+drag, middle mouse, trackpad/wheel), zoom (Ctrl/⌘+wheel,
  pinch, buttons, fit, reset), viewport culling and low-detail rendering when zoomed out.
- Tools: select, rectangle, ellipse, text, sticky, pen, arrow, and a system-shape palette with
  vector Lucide icons. Arrows bind to shapes and re-route live on move/resize/rotate; endpoints
  can be dragged to re-bind.
- Selection (click, Shift+click, marquee), move with smart guides (⌘/Ctrl disables), optional
  grid snap, resize/rotate (Konva Transformer, scale baked into the model), group/ungroup,
  align/distribute, reorder, duplicate, delete, nudge, copy/cut/paste via the system clipboard
  (works across tabs/boards; plain text pastes as a text shape).
- Keyboard-first: single shortcut table drives both key handling and the "?" cheat sheet;
  "/" quick insert places a shape to the right of the selection and connects it; Tab cycles
  shapes. Right-click context menu. Properties panel (label, engine/role, queue mode, edge type,
  stroke/fill swatches, stroke width/style, font size, opacity, arrange/align).
- Export PNG and SVG (own SVG serializer; PNG rasterized from it so off-screen shapes are
  included).
- Tests: shared 52 board tests (schemas, store, z-order, history, clipboard); web 76 unit and
  component tests (arrow geometry incl. rotation, viewport, snapping, align, simplify,
  shortcuts, SVG, controller commands, pointer gestures, properties panel, dialogs); Playwright:
  arrow stays attached after a move + undo restores, keyboard-only client → LB → 2 services →
  DB + cache, "?" dialog, PNG/SVG download; perf script.
- Perf (`pnpm --filter @whiteboard/web perf`, headless Chromium on the dev Mac): 2,000 shapes
  pan at **60 fps (p95 frame 17 ms)** at 100% zoom and with all 2,000 on screen.

### Phase 2 — Real-time sync server

- Wire protocol + client in `packages/shared/src/sync` (used by the browser AND the server's
  integration tests): y-protocols sync (step 1/2, updates) and awareness over binary
  WebSocket messages; zod presence schema; `SyncProvider` with exponential backoff + jitter,
  status (connecting / connected / reconnecting / offline), instant drop/resume on browser
  offline/online, per-frame batching of local updates, remote updates applied with the
  provider as origin (undo never reverts other people's edits).
- `apps/server/src/sync`: `/rooms/:boardId` on the HTTP port. Upgrade checks: board id (zod),
  Origin, then `authorize(request, boardId) → role` (Phase 2: `allowAllConnections`, a single
  swap point for Phase 4). One in-memory Y.Doc + Awareness per room, evicted 30 s after the
  last client leaves via an `onEvict` hook (Phase 3 persists there). Per connection: 8 MB
  message cap, message-rate and byte-rate token buckets (close 1008), heartbeat ping/pong with
  termination, slow-consumer close (1013) above 4 MB buffered, malformed input closes 1007,
  awareness validated and bound to the connection that first claimed a client id (no
  spoofing someone else's cursor), viewer role can read but not write.
- `GET /metrics` (Prometheus via prom-client): `sync_rooms_active`, `sync_connections_active`,
  `sync_messages_total{type}`, `sync_update_bytes_total`, `sync_connections_rejected_total`,
  `sync_connections_closed_total{code}` + process metrics; bearer `METRICS_TOKEN` (required in
  production, generated by Render in `render.yaml`).
- Web: `/board/:boardId` (lazy, keyed per board); "New board" and `/board/local` create a new
  random id; copy-link button. Guest identity (random name + colour per browser, renameable).
  Connection status pill, presence avatars (one per person), live cursors (HTML overlay),
  remote selection outlines in each user's colour, follow mode (viewport mirrors theirs; my
  own pan/zoom, Esc, or them leaving stops it).
- Tests: server 40 (upgrade checks, auth hook, two real clients converging after concurrent
  conflicting edits, offline edits merging, server restart recovery, presence add/remove and
  validation and anti-spoofing, room isolation and eviction, 1009/1008/1007 closes, >1 MB
  board sync, metrics + token); shared +6 (awareness validation, backoff, board ids) and env;
  web +7 (identity, throttle, peers store, status/avatars UI). Playwright with two browser
  contexts: A's shape appears for B and B's move appears for A; named cursors both ways;
  offline edits on both sides converge on reconnect; follow mode. All E2E: 10/10.
- Verified by hand: two tabs on one board (live edits, cursor, selection outline); stopping the
  server shows "Reconnecting…", restarting it recovers both tabs with the board intact.

### Phase 3 — Persistence + offline

- Migration `0001_boards_and_history`: `boards`, `board_updates` (write-ahead log),
  `board_snapshots` (every snapshot kept), `board_update_archive` (compacted history). RLS on
  all (the RLS guard test covers them). Board ids are UUIDs.
- Server: `PgBoardRepository` (load / append / compact, each one transaction) behind a
  `BoardRepository` interface (in-memory double for fast tests). Each room loads snapshot +
  later updates before answering any client; `RoomPersistence` batches every applied update
  into board_updates (≤ `SYNC_FLUSH_MS`=50 ms or 500 updates per INSERT), acknowledges with a
  new `persisted` message only after commit, retries failed writes with backoff, and compacts
  after `SNAPSHOT_EVERY_UPDATES`=500 updates, on eviction and on shutdown. Updates record the
  sender's Yjs client id and (guest) user id.
- Graceful shutdown (SIGTERM): stop accepting upgrades (503) and new messages → wait for rooms
  still loading → flush every room (retrying until the deadline) → snapshot → send final
  acknowledgements → close sockets 1012 → close HTTP/Redis/Postgres.
- Metrics: `sync_pending_updates`, `sync_flush_seconds`, `sync_room_load_seconds`,
  `sync_persist_failures_total`, `sync_compactions_total`.
- Web: y-indexeddb local copy per board (opens instantly and offline; offline edits survive
  closing the tab); service worker (vite-plugin-pwa/Workbox) precaching only the app shell so
  a board opens with no network; status "Saving… / Saved / Reconnecting… / Offline" driven by
  server acknowledgements; offline banner ("You're offline — changes are saved on this device
  and will sync when you reconnect"; also shown while reconnecting with unsaved changes).
- Tests: server 54 (persistence with in-memory repo: ack-after-commit, outage → no ack → retry,
  batching, reload after restart, eviction snapshot, threshold compaction with contiguous
  history, shutdown flush, deleted board 4404, load failure 1011; real Postgres: 10,000 updates →
  compaction → reload equals the original and all 10,000 are archived; snapshot + tail load;
  2,000-shape cold load; real-process `kill -9` crash test; real-process SIGTERM test). Web 86
  (+ IndexedDB cache with fake-indexeddb, save/offline UI). Playwright 14 (+ Saved indicator,
  offline edit → close tab → reopen online → visible to another browser, open board with no
  network via service worker, 2,000-shape load time).
- Measured (dev Mac in India → Supabase ap-southeast-1): cold load of a 2,000-shape board from
  Postgres **~850–900 ms** (server test); open-and-draw in a fresh browser **~580–610 ms**
  (Playwright, room already in server memory); compaction of that board ~2 s (background).
- Crash test result: 200/200 acknowledged edits recovered after `kill -9`; the 100 edits sent in
  the last few ms (unacknowledged, sender also gone) were not — as the guarantee allows.

### Phase 4 — Auth, workspaces, permissions, sharing

- Migrations `0002_auth_sharing_audit` (profiles.email; boards.org_id / folder_id / is_public /
  thumbnail_path; `organizations`, `memberships`, `folders`, `board_members`, `share_links`,
  `invites`, `board_visits`, `audit_logs`, all with RLS on and no policies) and
  `0003_storage_buckets` (private `board-thumbnails` bucket, PNG only, 300 KB).
- Auth: Supabase Auth in the browser (magic link, Google, GitHub; PKCE; `/auth/callback`
  handles both `code` and `token_hash`); sign out / sign out everywhere (Supabase global
  scope) also deletes every IndexedDB board copy and cached board details. The server verifies
  the access token on every REST request against the project's JWKS (`jose`, asymmetric keys
  only). `POST /me/bootstrap` (first sign-in) creates the profile + personal workspace and
  accepts pending invites addressed to the user's verified email.
- Permissions: one table `can(role, action)` (read/write/share/delete) used by REST and the
  WebSocket. Effective role = highest of board membership, org owner/admin (→ owner), a valid
  share link (signed-in users only) and the public toggle (→ viewer).
- Sync auth: `POST /boards/:id/ticket` returns a 5-minute HS256 room ticket {userId, boardId,
  role} signed with `ROOM_TICKET_SECRET`; the client sends it as a WebSocket subprotocol
  (`ticket.<jwt>`, never in the URL). The upgrade checks Origin, verifies the ticket, and
  re-checks the role in the database (lower of ticket and current role wins); every reconnect
  gets a new ticket. Viewers' sync/update messages are dropped server-side
  (`sync_write_denied_total`) and the web store is read-only for them.
- Revocation: removing a member, revoking a share link, turning public off or deleting a board
  publishes an event (in-process now, Redis pub/sub when `REDIS_URL` is set) that closes the
  matching sockets (4403 → client re-tickets and gets its new role or "No access"; 4404 for
  deleted boards).
- Sharing dialog (owners): invite by email with role (email via Resend or logged in dev),
  pending invites + revoke, members with role change / remove, create/copy/revoke viewer or
  editor share links (only a SHA-256 hash is stored), public read-only toggle. Members can
  leave a board. Landing pages `/s/:token` and `/invite/:token` (sign-in first).
- Dashboard `/app`: My boards, Shared with me, Recent, Trash; search; folders (create, rename,
  delete → boards kept); create, rename, duplicate (copies content into my workspace), move to
  folder, delete (soft) and restore within 30 days; `POST /internal/purge-trash` (CRON_SECRET)
  hard-deletes older trash and its thumbnail.
- Thumbnails: rendered in the browser 5 s after the user's own edits (at most once a minute),
  uploaded as PNG to the server, stored in private Supabase Storage with the service key; the
  dashboard gets 5-minute signed URLs.
- Rate limits (`@fastify/rate-limit`, Redis store when available): 300 req/min per user/IP
  overall, 60 tickets/min, 20 invites/hour. Auth itself (sign-in emails) is rate-limited by
  Supabase Auth.
- Audit: every board create/delete/restore/purge, public on/off, member add/role change/remove,
  invite create/accept/revoke and share-link create/revoke writes an `audit_logs` row.
- Verified in the browser (2026-09-25, dev Supabase project): magic-link sign-in → workspace;
  create board, draw, thumbnail on the dashboard (signed Storage URL); invite by email (link
  in the server log) → invitee opens it → "View only"; viewer's keyboard edits and a raw
  WebSocket Yjs update from the console are both rejected (`write_denied`, board unchanged);
  promote to editor applies live; removing the member and revoking a share link each show
  "Your access was removed" within ~0.75 s; sign out / sign out everywhere clear local data;
  folders, move to folder, trash, restore; `audit_logs` has every action with its actor.
  Bugs found and fixed while doing this (each with a regression test):
  - Opening an invite link after sign-in had already auto-accepted it said "invalid" — accept
    is now idempotent for the same user (never re-grants after removal).
  - Viewers were stuck on "Saving…": `BoardStore` stamped `schemaVersion` into the doc at
    construction (before sync), an update the server rightly drops for viewers. Now stamped
    with the first local edit (editors also no longer write on every open).
  - A removed member's browser kept the board in IndexedDB (openable offline): the local copy
    and cached details are now wiped when access is revoked or the board is deleted.
  - A new user's "Shared with me" stayed empty until reload (dashboard loaded before the
    sign-in bootstrap accepted their invites): board lists refresh after bootstrap.
  - Board open went from 2.8 s to 1.2 s (2,000 shapes, from here to Singapore): access is
    resolved in one query instead of up to four, and the room ticket is requested in parallel
    with the board details.
- Tests: server 117 (authz matrix: role × read/write/share/delete over REST and WebSocket,
  viewer sending raw Yjs updates can't change the board, revocation kicks live sockets, links
  and public toggle, invites, audit rows, rate limits; dashboard, folders, duplicate,
  thumbnails, purge). Shared 83, web 86. Playwright 17 incl. `auth.spec.ts`: magic-link sign-in (link
  generated with the admin API), create board, invite second user who edits live; viewer via
  link is read-only; revoking the link kicks the viewer. Existing E2E specs now sign in first.

### Phase 5 — Horizontal scaling + load testing

Full write-up with diagrams and numbers: [docs/scaling.md](docs/scaling.md).

- **Rooms shared across instances** (`apps/server/src/cluster/`): one Redis pub/sub channel
  per room (`wb:room:{boardId}`), binary zod-validated envelopes tagged with the sender's
  instance id (own messages ignored; remote changes applied with `REMOTE_ORIGIN` and never
  re-published → no echo loops). A room subscribes before loading from Postgres, then asks
  peers for newer state (`syncRequest`/`syncReply`) and their clients' presence. Periodic
  resync (`SYNC_RESYNC_MS`, 15 s) and an immediate resync after a Redis reconnect repair
  lost pub/sub messages. `LocalRoomBus`/`LocalLease` keep single-instance development
  without Redis unchanged.
- **Persistence ownership:** a Redis lease per room (`SET NX PX`, Lua compare-and-set renew
  and release, TTL `SYNC_LEASE_TTL_MS` = 15 s) picks the one writer, which persists every
  update and relays "persisted" acknowledgements to the other instances' clients. Seqs are
  now allocated by the database (migration `0004_board_seq_counter`: `boards.last_seq`,
  backfilled) in a **single-statement append**, so writes are idempotent and a second writer
  (split brain, or Redis down → fail open) can never corrupt a board. New writers (after a
  crash or handover) and non-writers leaving a room first write a **catch-up update**
  (exactly what the database lacks, deletions included). Graceful shutdown/eviction releases
  the lease and announces it, so another instance takes over at once.
- **Presence across instances:** a client id held on another instance can be reclaimed only by
  the same signed-in user (a tab reconnecting after its instance died); cursor removal on
  leave now reaches other instances immediately.
- **Revocation events** use the shared instance id over Redis (tested across instances).
- **Database pool:** `DATABASE_POOL_MAX` (6 per instance in `render.yaml`); sync persistence
  may use at most half the pool (`LimitedWritesRepository`) so socket authorization and room
  loads are never starved. `INSTANCE_ID` (default Render's `RENDER_INSTANCE_ID`) is in every
  log line; a "sync connection opened" info log per socket shows which instance serves it.
- **Metrics:** `sync_cluster_messages_total{kind,direction}`, `sync_cluster_dropped_total`,
  `sync_rooms_writer`, `sync_lease_changes_total`, `sync_cluster_resyncs_total`.
- **Scale stack:** `docker-compose.scale.yml` (Redis, `supabase/postgres` + migrate, 2
  instances, nginx round-robin without stickiness on :8080, instances on :4001/:4002) with
  `apps/server/Dockerfile` + `.dockerignore`; `pnpm scale:local` runs the same topology
  natively (`infra/scale/run-local.sh`, same nginx template).
- **Load tests (`loadtest/`):** k6 scenarios (a) 50 editors in one room and (b) 2,000
  connections across 200 rooms, a dependency-free codec producing byte-identical Yjs
  updates (tested against Yjs), a Node generator with the same traffic model for machines
  where k6 can't drive 2,000 sockets, a latency probe, `sample.sh` + `summarize-stats.mjs`
  for CPU/memory; `pnpm load:seed a|b|cleanup` creates real users/boards/memberships and
  room tickets.
- **Measured** (one Mac: generator + 2 instances + nginx + Redis; Supabase dev DB 76 ms away):
  (a) 50 editors: propagation **p50 3 / p95 9 / p99 14 ms**, 587,801 deliveries, 0 missed,
  0 errors, ~13 % of a core and 150 MB per instance. (b) 2,000 connections on 2 instances:
  **p50 1 / p95 8 / p99 12 ms**, 0 failed/dropped/missed; all 2,000 on **one** instance:
  **p95 7 ms**, 38 % of a core, 184 MB. Connection setup and "Saved" are database-bound from
  the dev machine (see Known issues). Kill -9 failover: reconnect ~210–240 ms, 375/375 edits
  stored; SIGTERM handover ~0.7–1.1 s.
- **Bottlenecks found and fixed:** Supabase pooler cap (2 × 10 connections > 15 →
  `EMAXCONNSESSION`, rejected upgrades and failed room loads); persistence writes starving
  reads (tens of seconds to open a board under load); 4-round-trip appends (→ 1; "Saved" p50
  842 → 312 ms in scenario a); k6's own limit on the dev Mac (~500 message-heavy sockets).
- **Tests:** server 139 (+22): `cluster.redis.test.ts` (12: two in-process instances on a real
  Redis — edits/cursors both ways, late joiner, no echo, lost-message repair, single
  writer + relayed acks, handover, writer death + catch-up + cursor reclaim, split brain,
  spoofing, revocation, malformed messages), `failover.pg.test.ts` (2 real processes behind
  a round-robin proxy: kill -9 and SIGTERM), lease/envelope (5), concurrent seq allocation,
  write limiter (2). Loadtest codec 5. CI gets a Redis service (`TEST_REDIS_URL`).
- **Browser check:** the full Playwright suite (17/17) passes with every request and socket
  round-robined across both instances by nginx; 6 boards had live clients on both instances
  during the run, 0 server errors.

### Phase 6 — Typed graph + rules engine (no AI)

- **`packages/graph`** (pure TypeScript, no I/O, no Yjs):
  - `extractGraph(shapes: Iterable<unknown>)` → `{ nodes, edges, ignored }`. Every record is
    validated with the board's `shapeSchema`; anything that isn't a graph element is reported in
    `ignored` with a reason (`not_a_component`, `invalid`, `duplicate_id`, `dangling_arrow`,
    `arrow_to_non_component`), never thrown. Nodes carry `kind`, `label` (the kind's name when
    unlabeled, plus `props.unlabeled`), `props.instances`, `groupId`, database
    `engine`/`role`, queue `mode`. Edges carry `arrowId` (the canvas arrow), `edgeType`, `label`.
  - Arrows bound to a plain shape inside a group (a frame around components) resolve to the
    group's components, one edge each (`id = arrowId:from->to` when an arrow fans out).
    Self-pairs produced only by that fan-out are dropped; a self-loop drawn on one component
    is kept.
  - Instance count: same kind + same label apart from a trailing number ("Order service 1/2",
    "#2", "instance 2"), or an explicit count ("API ×3", "x3", "3x", "3 instances/replicas/pods").
  - Zod schemas + types for the graph and findings (`designGraphSchema`, `findingSchema`) —
    the single definition the web app uses now and the AI boundary will validate against.
  - Rules engine: each rule is `{ id, description, check(ctx) → Finding[] }` over a shared
    `GraphIndex` (adjacency, islands, reachability, iterative Tarjan SCC, longest path over
    the SCC condensation). `runRules` isolates a throwing rule (`ruleErrors`), de-duplicates by
    stable finding id (`ruleId:sorted shape ids`) and sorts by severity → rule → board
    position. `checkDesign(shapes, { maxSyncDepth })` does both steps.
  - Rules: `db-spof` (critical), `client-direct-db` (critical), `sync-cycle` (critical),
    `no-load-balancer`, `read-path-no-cache`, `deep-sync-chain` (> `maxSyncDepth` = 3
    service/worker/external-API hops), `queue-no-dlq`, `storage-no-cdn` (warning; info when
    storage is reached only indirectly), `disconnected` (info). Each finding has a title,
    explanation, suggestion and the shape ids (components and arrows) to highlight.
- **Web:**
  - "Check design" button in the board header + `Shift+C` (listed in the "?" sheet under
    Review). Runs in the browser on the current snapshot; nothing is written to the board or
    sent to the server, so viewers can use it too.
  - Findings panel (right side; the properties panel moves beside it): findings grouped by
    severity with icon + text badge, explanation and "Fix:"; summary line; live-region
    announcement; "N shapes not checked" list with reasons; "The board changed since this
    check" + Re-check when stale; focus moves to the panel on open, Escape closes it and returns
    focus to the button.
  - Clicking a finding (or a not-checked shape) outlines its shapes in the severity colour on a
    separate highlight layer (not the selection, not broadcast to others) and zooms to fit them
    in the free area (max 125%). A fixed finding's highlight disappears on re-check.
  - Debug hook: `designCheck()` / `designCheckFocus()` for E2E.
- **Tests:** graph 80 (extraction incl. groups, dangling/missing/invalid/duplicate, instance
  conventions; a positive and a negative fixture board for every rule, 33 fixtures, asserting
  exact severity + shape ids; a healthy reference design with zero findings; engine
  ordering/isolation/dedupe/`maxSyncDepth`/cycles; the acceptance scenario; fast-check
  property tests — 500 random boards each with corrupt records and arbitrary values:
  `extractGraph` and every rule never throw, edges only join nodes, every record is accounted
  for, every finding's shapes exist; 2,000-shape performance bound). Web 100 (+14: store,
  staleness, highlight kept/dropped on re-check, panel rendering/keyboard/Escape/empty/not
  checked/stale, `zoomToShapes`, shortcut). Playwright 18 (+1 `check.spec.ts`: draw service →
  DB, Check design → critical SPOF, click → DB highlighted and zoomed to; add replica + set
  Replica role + Replication arrow → stale notice → Re-check → finding gone; Escape/Shift+C).
- **Measured:** `checkDesign` on a 2,000-shape board ≈ 17 ms (dev Mac, Node).

### Phase 7 — AI design review (Claude)

- **Data** (migration `0005_ai_reviews`, RLS on, no policies — covered by the RLS guard test):
  `entitlements` (user → plan free/pro/team + optional monthly review override; no row =
  Free), `reviews` (board, requester, status running/completed/failed, problem statement,
  requirements, the reviewed graph + rule findings, validated result, error code),
  `ai_usage` (one row per Claude call — kind, model, status, input/output/cache-write/
  cache-read tokens, cost in micro-USD, latency, Anthropic request id, hint fingerprint; no
  FKs so spend records outlive boards/users). Plan limits in `packages/shared/src/plans.ts`
  (Free 5 reviews/month, Pro 100 + live hints, Team 300/seat + live hints).
- **Contract** (`packages/graph/src/review.ts`): review request, AI review (summary, 1–10
  score per dimension — scalability, reliability, data design, security, cost — findings
  {severity, dimension, title, explanation, shapeIds, suggestion, ruleId}, follow-up
  questions), stored record + summaries, streamed events, hints, `diffReviews` (matches
  findings by dimension/rule + ≥ 50 % shared shapes → new / still open / resolved + score
  deltas), `graphFingerprint` (kinds, labels, settings, connections — not positions/styles).
- **Server** (`apps/server/src/ai/`, `src/api/reviews.ts`):
  - `POST /boards/:id/reviews`: sign-in + read access (viewers included; billed to the
    requester) → AI switch / API key / daily spend kill-switch (503) → reads the board **from
    the database**, never the request body → empty (422) / oversized (413, >600 elements) →
    quota check + `running` reservation in one transaction under a per-user advisory lock
    (402 `QUOTA_EXCEEDED`, Claude never called) → server-sent events (stage/progress/done/
    error, 15 s keep-alive). Client disconnect aborts the Claude call.
  - Claude call: `claude-sonnet-5`, adaptive thinking, effort `high` (env), `max_tokens`
    16,000 (env), streaming, **structured outputs** with a hand-written JSON schema (the
    SDK's zod converter drops enums), **no tools**, static system prompt cached with
    `cache_control` (6.1k characters ≈ 1.5k tokens, above Sonnet 5's 1,024-token minimum).
  - The graph is sent as compact JSON with short refs (`n1`, `e1`, `g1`) inside
    `<untrusted_board_data>`; labels/requirements are NFKC-normalised, control and format
    characters stripped, length-capped and `<`/`>`/`&` escaped so text can't close the tag.
    The system prompt says the block is data, never instructions, and asks the model to
    report instruction-like labels as an info finding.
  - Repair, no second paid call: refs → canvas ids (a finding on an arrow highlights the
    arrow), a real canvas id or an exact unique label is accepted, anything else dropped; a
    finding with no valid shape is dropped; scores clamped; text trimmed; findings sorted by
    severity and numbered `f1…`; the result is re-validated against the public schema.
  - Every call writes `ai_usage` (ok/error/refused/truncated/invalid_output/aborted) in the
    same transaction as the review's status change. Quota counts completed reviews and
    user-aborted ones (tokens were spent) + live reservations (< 10 min); our failures are
    free. `GET /boards/:id/reviews`, `GET /boards/:id/reviews/:reviewId` (read access),
    `GET /me/ai-quota`.
  - `POST /boards/:id/hints` (editors, Pro/Team else 402 `PLAN_REQUIRED`): < 3 components or
    the same graph fingerprint as my last hint on this board within the hour → skipped with
    no call; `AI_HINTS_PER_HOUR` (20) per user → 429; `claude-haiku-4-5-20251001`, 0–3
    hints, same data block and repair; best effort (failures return no hints).
  - Env: `ANTHROPIC_API_KEY` (required in production; without it AI routes answer 503),
    `AI_ENABLED`, `AI_DAILY_SPEND_LIMIT_USD` (20), `AI_REVIEW_MAX_TOKENS`, `AI_REVIEW_EFFORT`,
    `AI_REVIEW_MAX_ELEMENTS`, `AI_HINT_MAX_TOKENS`, `AI_HINTS_PER_HOUR`; `.env.example` and
    `render.yaml` updated.
  - `pnpm --filter @whiteboard/server plan:set <email> <free|pro|team> [reviews/month|-]`
    (development/test only; writes an `entitlement.change` audit row).
- **Web:** "AI review" button (signed-in users) + `Shift+R` (in the "?" sheet). Panel:
  history picker, progress steps (with tokens written, Cancel), summary, score meters,
  numbered findings (severity + dimension badges; click → highlight + zoom), "Compare with
  the previous review" (New / Still open badges, resolved list, score deltas), follow-up
  questions, "board changed since this review", live-hints toggle. Start dialog: problem
  statement + requirements (pre-filled from the last review), "N of M reviews left", what is
  sent to Anthropic, waits for "Saved". Numbered pins over the canvas (HTML buttons with
  labels; top-right of a box / middle of an arrow; stacked when several). 402 → upgrade
  dialog with the plan comparison ("Upgrade — coming soon"). Hint cards at the bottom
  (Show on board / Dismiss; dismissed stays dismissed for the same shapes). The design
  check and AI review panels are mutually exclusive.
- **Eval** (`apps/server/eval/`, `pnpm --filter @whiteboard/server eval:review`): 15 fixture
  boards with 16 planted flaws (write scaling for a URL shortener, DB SPOF, client → DB,
  payment retries without idempotency, in-memory sessions, celebrity fan-out, public API
  without rate limits, blocking slow vendor, queue without DLQ, dual write to search, video
  without CDN, chat by polling, prompt-injection label, `LIKE '%q%'` search, analytics on the
  OLTP primary). Deterministic grading (no LLM judge): a flaw is caught when a finding points
  at one of its shapes, is at least its severity and matches its keywords. Prints per-board
  results + cost; JSON in `eval/results/` (gitignored); exits 1 below 12/15.
- **Tests:** server +59 (`ai.test.ts` 18: pricing, data block/escaping, schema agreement,
  repair, every model outcome; `reviews.pg.test.ts` 22 with a fake model on real Postgres:
  401/403/400/422/413 without a call, stream + stored review + `ai_usage` tokens/cost,
  escaped hostile label, ref repair, list/get authz, 4 failure kinds (logged, quota unused),
  client abort (call cancelled, counted), 402 without a call, parallel requests at quota − 1
  → one 200 + one 402, `AI_ENABLED=false`, spend limit, no key, hints plan/role/skip/hourly
  cap; `evalGrade.test.ts` 19: fixtures valid, grader credits only the right findings).
  Graph +7 (diff, fingerprint, contract). Web +19 (SSE parsing across chunks, store: open/
  stream/402/errors/cancel, hints: 8 s debounce, ≥ 3 components, moves and other people's
  edits don't trigger, dismiss, 429 pause; pins placement + buttons; panel, comparison,
  progress, upgrade dialog, shortcut). Playwright +2 (`review.spec.ts`, review API mocked in
  the browser: streamed review → numbered pins on the right shapes → click highlights; a 402
  shows the upgrade dialog).

## Decisions

- **Tool versions — proven majors over newest.** TypeScript 5.9 (typescript-eslint 8 supports
  < 6.1; TS 7 is the Go port), ESLint 9, Vite 7, Vitest 4, React Router 7 (v8 needs
  Node ≥ 22.22), pnpm 10 (v11/12 changed config/build-script handling). Upgrade deliberately later.
- **No Docker, Supabase only (user decision, 2026-09-25).** Replaces CLAUDE.md's local
  docker-compose + `supabase start` setup: development runs against a separate hosted Supabase
  dev project; the Supabase CLI dev dependency, `supabase/config.toml` and `docker-compose.yml`
  were removed. CI still needs a throwaway database, so it runs Supabase's own
  `supabase/postgres` image as a service container (same roles and `auth` schema as hosted).
- **Redis optional outside production (user decision, 2026-09-25).** `REDIS_URL` may be empty
  in development/test; `/readyz` then checks only Postgres. It stays required when
  `NODE_ENV=production`, because 2+ Render instances share state through Redis (CLAUDE.md).
- **Drizzle is the single source of truth** for the schema (CLAUDE.md). `drizzle-kit` uses
  `schemaFilter: ['public']` to never touch Supabase-owned schemas; the FK to `auth.users` uses
  `drizzle-orm/supabase`'s `authUsers`.
- **`pnpm test` includes the DB-backed RLS test** (approved) — it reads `DATABASE_URL` from the
  environment or `apps/server/.env` and fails loudly instead of skipping. `pnpm dev` runs
  `db:migrate` first (approved; dev only).
- **Workspace packages ship TypeScript source** (no build step for shared/graph/config). The
  server is bundled with tsup (workspace code inlined, npm deps external); the web app's Vite
  config uses `--configLoader runner` so it can import the shared env schema.
- **Redis client fails fast** (`enableOfflineQueue: false`) so `/readyz` reports an outage
  immediately and requests never queue indefinitely; it keeps reconnecting with capped backoff.
- **`/healthz` never checks dependencies**, so a Redis blip can't get every instance restarted.
- **CORS pattern is auto-anchored** (`^(?:…)$`) so `…vercel.app.evil.com` can't match.
- **No CORS credentials** — auth is a bearer token, not cookies.
- **Web env schema contains only what Phase 0 uses** (`VITE_API_URL`); Supabase/WS/Sentry/PostHog
  vars are added in the phases that read them, so no variable is required before it's used.
- `packages/graph` exports `GRAPH_FORMAT_VERSION` only, to give its test something real to check.

- **Z-order is a fractional-index key on each shape, not a Y.Array (approved, Phase 1).** One
  source of truth; concurrent reorders can't duplicate a shape (a Y.Array reorder is
  delete+insert, which duplicates under concurrency). Ties broken by id; renumbered if
  neighbours ever share a key.
- **`style` is a nested Y.Map** so concurrent edits to different style keys merge; other
  fields are last-writer-wins per field. Freehand points are one immutable array value.
- **Arrows store bindings, not positions.** Bound ends are computed from the bound shape on
  every render, so nothing needs rewriting when a shape moves. Deleting a shape deletes arrows
  bound to it. Straight arrows only (no orthogonal routing).
- **Every read from and write to the Y.Doc is zod-validated**; invalid remote shapes are
  skipped and reported rather than crashing the renderer (ready for Phase 2 network data).
- **One undo step per user action**: commands run inside `runAsSingleStep`, gestures use
  `beginStep`/`endStep` so a slow drag with pauses still undoes in one go; arrow-key nudges
  merge within 500 ms.
- **Editing logic has no Konva/DOM dependency** (`BoardController`, `CanvasInteractions`), so
  it is unit-tested directly; Konva is only a renderer.
- **Selection, tool and drafts are local UI state**, not in the Y.Doc (Phase 2 adds presence).
- **Board session is not torn down on unmount**: it is a self-contained object graph that is
  garbage-collected; destroying it in an effect cleanup broke React StrictMode's dev remount
  (found while testing). External side effects (debug hook; later the network provider) use
  effects.
- **Browser `dblclick`, not Konva's**: Konva fired a double-click for two quick clicks at
  different places (placing two shapes), which created stray text boxes (found by E2E).
- **Test hooks** (`window.__whiteboard`) exist only in builds with `VITE_DEBUG_TOOLS=true`
  (E2E/perf); production builds never set it. Added to the web env schema.
- **No persistence yet**: `/board/local` is in memory; the header says "Not saved yet".
- **Groups are one level deep**; clicking a grouped shape selects the group.
- New shape and fit-to-screen keep clear of the floating panels.

- **Message cap is 8 MB, not 1 MB, plus a byte-rate limit (Phase 2).** Measured: a
  2,000-shape board with some edit history is ~1.9 MB, and a reconnecting client sends its
  whole state in one sync message, so 1 MB would lock large boards out forever. Abuse is
  bounded by per-connection token buckets for messages (120/s, burst 300) and bytes
  (1 MB/s, burst 16 MB). Server→client messages up to 64 MB are accepted.
- **Server restart recovery comes from the clients**: on reconnect each client's sync step
  sends the server what it lacks, so an emptied room is refilled as soon as anyone who had the
  board reconnects. Phase 3 adds real persistence.
- **Rooms are per instance** (Phase 2 is single-instance); Phase 5 shares them via Redis.
- **Auth is deliberately open in Phase 2** (`allowAllConnections`): anyone with a board URL can
  edit it. Board ids are random UUIDs, so they are unguessable, but not secret once shared.
  Phase 4 replaces the hook; nothing else changes.
- **Guest identity** until Phase 4: random "Adjective Animal" + AA-contrast colour stored in
  localStorage (a second/incognito browser is a different guest); used as `createdBy`.
- **Cursors are HTML over the canvas**, not Konva: moving a cursor never redraws the canvas.
  Cursor publishing is throttled to 20/s, viewport to 10/s.
- **Web depends on the Awareness class only**; Yjs itself stays behind `BoardStore`, so there
  is exactly one `yjs` copy in the bundle (two copies break Yjs).

- **Durability guarantee (Phase 3).** Every update the server applies is appended to
  `board_updates` within `SYNC_FLUSH_MS` (50 ms), in order. A client is told its edits are
  durable (status **Saved**) only by a `persisted` message sent **after** the batch commits;
  it carries the state vector captured when the batch was cut, i.e. exactly what is now in
  Postgres. Therefore: **an edit shown as Saved survives any server failure, including
  kill -9** (verified by the crash test). An edit not yet Saved lives in the editor's browser
  (memory + IndexedDB) and in any peer that received it; it is re-sent automatically on
  reconnect (Yjs sync step), so it is lost only if the server dies within ~50 ms of receiving
  it _and_ every browser holding it loses its local storage before reconnecting. Live
  collaboration is not delayed by the database: updates are broadcast to peers immediately
  and only the durability acknowledgement waits for the commit.
- **History retention for replay (Phase 8): archive + all snapshots.** Compaction moves updates
  into `board_update_archive` (same row: seq, update, client id, user id, timestamp) in the
  same transaction that writes the snapshot, and snapshots are never deleted. Replay can seek
  to the nearest snapshot and play archived updates forward, with per-edit authorship and
  time. Periodic snapshots alone would lose everything between two snapshots (a scrubber needs
  every step). Yjs updates are small; storage/retention limits per plan are a Phase 10 concern.
- **Boards are created explicitly** (`POST /boards`, Phase 4) with an owner; the sync server
  no longer creates board rows, and edits to a missing board are dropped (`BoardMissingError`).
- **Compaction reads from the database, not memory**, inside one transaction that locks the
  board row (`SELECT … FOR UPDATE`), so it is exact and safe with multiple instances later.
  It is an optimisation: a failed compaction leaves updates safely in `board_updates`.
- **Eviction never drops unsaved edits**: if the final flush fails, the room stays in memory
  and eviction is retried.
- **Messages received while a room is loading are buffered and applied**, even if the client
  disconnects or shutdown starts meanwhile (found by the SIGTERM test).
- **Service worker caches only built files** (HTML/JS/CSS/SVG, network-first navigation via
  fallback); API and sync traffic are never cached. `sw.js` is served `no-cache` on Vercel.
  New dependency `vite-plugin-pwa` (approved).
- **Drizzle query helpers are re-exported from `@whiteboard/shared/db`**: pnpm resolved a second
  `drizzle-orm` copy for the server (different optional peers), which broke types.

- **Room ticket in `Sec-WebSocket-Protocol` + database re-check on upgrade** (Phase 4): URLs end
  up in logs; the re-check makes a removed member's old ticket useless immediately.
- **Only owners share** (invite, links, roles, public toggle); editors edit. Simplest model that
  matches the acceptance criteria; revisit with team plans (Phase 10).
- **Share links require sign-in**; anonymous access exists only through the public read-only
  toggle. Keeps every write attributable to a user.
- **Invites are accepted by verified email** (on `/invite/:token` or automatically at next
  sign-in), never by whoever holds the link.
- **Org owners/admins act as board owners** in their org; boards without an owner from before
  Phase 4 are inaccessible (dev data only).
- **Thumbnails are rendered in the browser** (we already have the Konva scene there) and
  uploaded; server-side rendering would need a headless canvas.
- **Cron endpoints live outside the user-auth scope** and use a separate `CRON_SECRET`.
- **Server tests run files sequentially** (`fileParallelism: false`): they share one hosted dev
  database and several measure timings.
- **Access is resolved in one SQL query** (board ⟕ membership ⟕ org membership ⟕ share link,
  all unique keys): it runs on every request and socket upgrade; each extra query is a full
  database round trip (~80 ms from a dev machine in India, ~1 ms on Render next to Supabase).
- **Removing access wipes the local board copy**, but an expired session doesn't (it may hold
  offline edits that sync after signing in again).
- **Migration 0003 (Storage bucket) is guarded by `to_regclass('storage.buckets')`**: the
  `storage` schema comes from Supabase's Storage service, which the bare `supabase/postgres`
  image in CI doesn't run. Edited in place (it had only been applied to the dev project, where
  the result is identical; drizzle doesn't re-run applied migrations).
- **CI E2E skips with a warning until the `CI_*` secrets exist** (also on fork PRs, which get
  no secrets) instead of failing every push.
- **Dev email transport logs invite links** instead of sending (`EMAIL_TRANSPORT=log`);
  production refuses to boot without Resend.

- **Persistence: one writer per room (Redis lease) + idempotent writes (Phase 5).** The lease
  keeps each edit written once and "Saved" exact (the writer's committed state vector is
  relayed to every instance); database-allocated seqs + idempotent Yjs updates make a second
  writer harmless, so correctness never depends on Redis or clocks. Rejected: every instance
  writing its own clients' edits (exact per-client acks would need per-instance vectors, and
  compaction would have N drivers).
- **Fail open when Redis is unreachable:** instances write without the lease rather than
  risk nobody persisting; duplicates are harmless. Cross-instance live updates stop until
  Redis returns (then a resync repairs them); `/readyz` reports the outage.
- **Catch-up write = apply our document to the stored board and keep what changes.** A
  state-vector diff misses deletions (they don't advance vectors). Costs one board load, only
  on writer change or when a non-writer leaves a room; falls back to the full state if the
  read fails.
- **Seq counter on the board row (`boards.last_seq`) + single-statement append** (CTE:
  reserve range + insert, batch as jsonb/base64): one round trip, row-locked, contiguous.
- **Per-room channels, binary envelopes, periodic resync (15 s)** instead of Redis Streams:
  pub/sub is simplest and fastest; Yjs makes repair cheap and idempotent. Resync replies
  always include the delete set (small).
- **Instance ids get a random per-process suffix**, so a restarted instance never inherits
  its previous life's lease.
- **Writes ≤ half the DB pool; `DATABASE_POOL_MAX` = 6 on Render** (2 × 6 + headroom ≤ the
  Supabase session pooler's 15). Found by the 2,000-connection test.
- **Load-test traffic is hand-encoded, not Yjs-in-k6:** Yjs in each of 2,000 VUs costs GBs;
  the codec's output is byte-identical to Yjs (tested). Latency is measured in steady state
  (after ramp + settle); connection setup separately.
- **Node generator alongside k6 (approved plan used k6):** k6 on the 8 GB dev Mac is accurate
  up to ~500 message-heavy sockets; the 2,000-connection numbers come from a Node generator
  with the same traffic model, cross-checked by k6 at 500 and an independent probe.
- **Native scale stack without Docker (dev machine has no Docker):** Redis 7.4.6 and nginx
  1.28 built from source and the k6 binary in `~/.local/bin` (outside the repo, nothing
  system-wide); `pnpm scale:local` mirrors `docker-compose.scale.yml`.
- **`TEST_REDIS_URL` (not `REDIS_URL`) for tests**, failing loudly when missing — like the
  RLS test with `DATABASE_URL` — so `pnpm dev` stays Redis-free.

- **Phase 6 decisions (approved plan):**
  - `extractGraph` takes shape records (`unknown`), not a Y.Doc: keeps the package Yjs-free and
    lets the server pass `doc.getMap("shapes").toJSON()` values later.
  - No instance-count field on shapes: instances are read from label conventions (same label
    - trailing number, or "×N"). No schema change this phase.
  - Plain rectangles/ellipses are never typed from their labels ("Postgres" in a rectangle is
    reported as not checked). Deterministic and explainable; label guessing is left to later.
  - Keyword rules (read path, DLQ, static content) only fire on a clear label signal, so
    unlabeled boards get fewer findings rather than noisy guesses.
  - `deep-sync-chain` counts only service/worker/external-API hops (client → LB → gateway →
    service → DB is normal); cycles count as one step (they have their own rule).
  - A replica counts for `db-spof` only when linked to the primary (replica-role database by
    any arrow, or any database by a replication arrow).
  - Graph/finding zod schemas live in `packages/graph` (the owner), not `packages/shared`:
    both apps import them from one place, so nothing is duplicated.
  - Checks run on demand, not live: the panel marks results stale instead.
  - New dev dependency `fast-check` 4.10.2 (approved) for the property tests.
  - `shapeTypeLabel` moved from `PropertiesPanel` to `model/systemShapes.ts` (now shared by the
    findings panel).

- **Phase 7 decisions (approved plan, "go with your recommendations"):**
  - `entitlements` table now (no billing): a missing row is Free; plans are set by the
    dev-only `plan:set` script until Phase 10. Limits live in code (`PLAN_LIMITS`).
  - Anyone with read access (viewers included) may run a review; it uses the requester's
    allowance and is visible to everyone who can open the board. Hints need edit access.
  - Routes follow the existing style: `/boards/:id/reviews` (not `/api/...`).
  - The board is read from Postgres, not from a live room or the request: correct on any
    instance and can't be spoofed; the web app waits for "Saved" before starting.
  - Structured outputs (`output_config.format`) instead of a forced tool call: no tools at
    all (injection containment), and forced `tool_choice` conflicts with thinking.
  - Findings are sent to the browser only after validation (progress events carry stages
    and a token count, not partial findings).
  - Quota is counted from `ai_usage` (outlives deleted boards, so deleting a board doesn't
    refund reviews) plus live reservations. User-aborted reviews count; our failures don't.
  - Pins are HTML buttons over the canvas (focusable and labelled), not Konva shapes.
  - Hints trigger only on my own edits (other people's edits would spend my hourly
    allowance), after 8 s of quiet, when the graph fingerprint changed.
  - Cost is stored as integer micro-USD; prices are a table in code (`ai/pricing.ts`), and an
    unknown model throws rather than silently bypassing the kill-switch.
  - New dependency: `@anthropic-ai/sdk` 0.128.0 (server only). The board fixture builder
    moved to `packages/graph/src/testing` (exported as `@whiteboard/graph/testing`) for the eval.

## Known issues

- `pnpm db:migrate` and the RLS test have not yet run against a real database: they need the
  Supabase dev project's `DATABASE_URL` in `apps/server/.env` (locally) and a CI run.
- Supabase pooler (session mode) caps connections per project on small plans; the server pool
  is `max: 10`. Watch for "max clients reached" when running dev + tests at once.
- `render.yaml` uses `/readyz` as the health check per CLAUDE.md. If Redis/Postgres has an
  outage, Render will mark every instance unhealthy at once — revisit in Phase 12/13
  (e.g. separate readiness vs. Render health semantics).
- Rollup prints harmless "annotation that Rollup cannot interpret" warnings from zod during
  `vite build`.
- Web bundle: main chunk ~430 kB; the board is a separate lazy chunk ~625 kB (195 kB gzip:
  Konva, Yjs, Radix). Vite warns about chunk size. Revisit in Phase 11/12.
- Canvas accessibility: toolbar, palette, panel, dialogs and menus are keyboard-operable and
  labelled, every action has a shortcut, Tab cycles shapes and selection changes are announced
  in a live region — but shapes themselves are drawn on a canvas and are not exposed to screen
  readers individually.
- SVG/PNG export uses the browser's system font; text wrapping in exports can differ slightly
  from the canvas.
- Perf numbers are from headless Chromium on one machine; real devices vary. The perf test
  is not run in CI (shared runners give meaningless frame rates).
- Playwright's "Desktop Chrome" profile reports a Windows user agent, so on a Mac the app
  expects Ctrl shortcuts in E2E; tests use a `modKey(page)` helper.
- Board content is also stored in each browser's IndexedDB (by design, for offline). It is
  cleared on sign-out, but stays if the user just closes the tab on a shared computer.
- E2E and persistence tests write boards to the database in `DATABASE_URL` (the dev project
  locally). Persistence tests delete what they create; E2E boards are left (like real usage).
- Hosted Postgres latency varies: one run saw a single compaction take 35 s (normally ~2 s) —
  a pooler/network stall. Compaction runs in the background and doesn't block editing, but
  watch `sync_flush_seconds` in production.
- Storage growth from the history archive is unbounded for now (retention limits: Phase 10).
- `pnpm test:e2e` reuses an already-running local server on :4000 / web on :4173 (faster
  locally); CI always starts fresh ones.

- CI E2E needs a dedicated Supabase project + the `CI_*` GitHub secrets (not set up yet);
  until then the job is skipped with an "E2E skipped" warning — don't mistake green for run.
- If an editor with unsynced offline edits is demoted to viewer, those edits can never be
  saved and the status stays "Saving…" (they are discarded only when the local copy is
  cleared). Rare; revisit with a clearer "these changes can't be saved" message.
- Local development API latency is dominated by the round trip to the Singapore database
  (~80 ms per query from India); production runs next to it.
- The dev log transport prints invite links (they contain the invite token) to the server
  log — acceptable locally; production refuses to boot with it.
- Verification users `verify-alice@example.com` / `verify-bob@example.com` exist in the dev
  Supabase project (plus a few boards).
- After "sign out everywhere", an already-issued access token stays valid until it expires
  (Supabase JWTs are stateless) — set the JWT expiry to 15 min. Sockets re-check at each
  reconnect/ticket.
- Ownership transfer and org (team) management UI are not built; a board's owner cannot leave it.
- Test users created by server/E2E tests are deleted afterwards, but their personal
  organizations remain in the dev database (no FKs to cascade). Harmless.
- Trash purge endpoint exists but nothing calls it yet (Render Cron Job in Phase 13).
- Thumbnails update only when someone edits in a browser; boards edited only by API/tests
  keep no thumbnail.

- **Phase 5 numbers are from one machine** (load generator, 2 instances, nginx, Redis on the
  dev Mac; clients' network legs excluded) against the Supabase dev DB 76 ms away. Under the
  2,000-connection load, connection setup (p95 1.2 s on 2 instances, 9.4 s on one) and
  "Saved" (p50 7.9 s / 16.7 s) are bound by those round trips; next to the database they
  should be a few ms and ~50 ms. Must be re-measured on Render staging (Later → Phase 13).
- `docker-compose.scale.yml` and `apps/server/Dockerfile` have **not been run** (no Docker on
  the dev machine); the native stack with the same nginx template was.
- `pnpm test` now needs a local Redis (`TEST_REDIS_URL`); the multi-instance tests fail
  loudly without one.
- After a crash the surviving instance takes over persistence within the lease TTL (15 s):
  edits keep flowing live meanwhile but show "Saving…" until then.
- A crashed instance's anonymous (public-link) viewers' cursors linger up to 30 s on other
  instances (signed-in users reclaim theirs on reconnect).
- Catch-up writes carry no author (client/user id null) — replay (Phase 8) shows them as
  system edits. A split brain can store duplicate updates; replay must tolerate (Yjs does).
- Deletions don't advance Yjs state vectors, so "Saved" can show for a deletion slightly
  before it is committed (pre-existing since Phase 3; the data is still written within the
  batch window). Documented; revisit with per-update acks if it matters.
- k6 can't drive 2,000 message-heavy sockets from the dev Mac; run scenario (b) with k6 from
  separate machine(s), or use `node-load`.
- One "sync connection opened" info log line per socket (useful to see which instance
  serves whom); at scale consider sampling or debug level.
- The load-test seed writes real users/boards to the database in `DATABASE_URL`; run
  `pnpm load:seed cleanup` afterwards (it refuses outside development/test).

- **Phase 6:** the "S3"-style labels lose their trailing digit when grouping instances
  ("S3" and "S4" of the same kind would count as 2 instances of "s"). Only the load-balancer
  rule uses instance counts, and only for services.
- The design check only understands palette shapes; boards drawn with plain rectangles get
  "N shapes not checked" and few findings.
- `storage-no-cdn` reports storage reached only through a service (e.g. uploads) as info,
  which can be a false positive when files are never served to users.
- The highlight survives edits until re-check or close; highlighted shapes that were deleted
  are simply not drawn.

- **Phase 7:** the eval has **not been run yet** (needs `ANTHROPIC_API_KEY`; ~$1–3 per run),
  so the ≥ 12/15 acceptance criterion is unverified. The prompt may need tuning after the
  first run; record each run's score here.
- The daily spend kill-switch is checked before each call: calls already in flight can
  overshoot the limit by at most their own maximum cost (~$0.20 each).
- The hint hourly cap is a count check without a lock: parallel hint requests from one user
  can exceed it by one or two (hints cost ~$0.002).
- Haiku 4.5 only caches prompts ≥ 4,096 tokens; the hint system prompt is shorter, so hints
  aren't cached (not padded on purpose — hints are cheap).
- Reviews read the stored board: an edit made in the last ~50 ms before "Start" (or while
  offline) isn't included; the dialog waits for "Saved".
- Hints are best effort: model errors return no hints silently (logged server-side).
- Team review allowance is per seat, not yet pooled across an organization (Phase 10).
- The "Upgrade" button is disabled ("coming soon") until billing exists (Phase 10).

## Later

- Phase 9 (private rooms): AI review of an E2E-encrypted board needs explicit per-review
  consent and must send only the extracted graph (SPEC §7); the review route reads the board
  server-side today, which won't work for ciphertext.
- Phase 10: pooled Team AI allowance; the upgrade dialog's button → checkout; plan changes
  via billing webhooks (audited), not the dev script; ai_usage-based cost dashboard.
- Phase 12: Sentry for AI failures (refusals, invalid output rate), PostHog events for review
  started/completed/upgrade shown; alert when daily spend nears the limit.
- Unscheduled: a "healthy design" eval board to measure false positives; run the eval in CI
  on prompt changes (needs a budgeted key).

- Phase 13: re-run the load tests against Render staging (2 instances + Key Value next to
  Supabase) and record connection setup / "Saved" latency; tune `DATABASE_POOL_MAX` to the
  Supabase compute's pooler size.
- If Redis or the DB becomes the limit (docs/scaling.md → bottlenecks): coalesce presence per
  room per tick and skip publishing for rooms no other instance holds; append several rooms'
  batches in one statement; load a board in one query instead of three.
- Phase 12 (security): enforce presence `user.id` == the socket's authenticated user id
  server-side (today a client may display any id/name in its own presence).
- Phase 8: replay = nearest `board_snapshots` row + `board_update_archive`/`board_updates` rows
  after it.
- Phase 10: retention limits for archived history per plan.
- Nice-to-have (unscheduled): orthogonal arrow routing, nested groups, arrow label drag.
- Unscheduled: live rule checks while drawing (cheap — ~17 ms for 2,000 shapes) alongside
  live AI hints.
- Unscheduled: an explicit `instances` field on service shapes in the properties panel;
  guessing kinds for plain shapes from labels ("Redis" rectangle → cache), probably via AI;
  per-board rule settings (disable a rule, `maxSyncDepth`).
- Phase 10: team organizations (members, admins), ownership transfer, per-plan limits.
- Phase 13: Render Cron Job calling `POST /internal/purge-trash` daily with `CRON_SECRET`;
  set `TRUST_PROXY=1` on Render so rate limits see real client IPs.
- Phase 11: prerender public pages (landing, pricing, templates, docs, legal) at build time.
- Phase 12: Sentry + PostHog, security headers in `vercel.json`, audit logging.
- Phase 13: production migrations via Render `preDeployCommand` (the migrate script currently runs
  through `tsx`, a dev dependency — bundle it or install dev deps on Render); real staging/prod
  services; `CORS_ALLOWED_ORIGIN_PATTERN` for this project's Vercel previews.
