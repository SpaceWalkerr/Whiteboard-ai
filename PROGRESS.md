# Progress

## Current phase

Phase 4 — Auth, workspaces, permissions, sharing: implemented, awaiting manual verification
(needs the Supabase publishable + service-role keys, see Known issues). Phases 0–3 committed.

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
- Tests: server 116 (authz matrix: role × read/write/share/delete over REST and WebSocket,
  viewer sending raw Yjs updates can't change the board, revocation kicks live sockets, links
  and public toggle, invites, audit rows, rate limits; dashboard, folders, duplicate,
  thumbnails, purge). Shared 82, web 85. Playwright `auth.spec.ts`: magic-link sign-in (link
  generated with the admin API), create board, invite second user who edits live; viewer via
  link is read-only; revoking the link kicks the viewer. Existing E2E specs now sign in first.

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
- **Dev email transport logs invite links** instead of sending (`EMAIL_TRANSPORT=log`);
  production refuses to boot without Resend.

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
- Sequence numbers come from an in-memory per-room counter: correct for one instance only.
  Phase 5 must allocate them safely across instances (the PK rejects duplicates, so a clash
  fails loudly rather than corrupting).
- Storage growth from the history archive is unbounded for now (retention limits: Phase 10).
- `pnpm test:e2e` reuses an already-running local server on :4000 / web on :4173 (faster
  locally); CI always starts fresh ones.

- Phase 4 E2E tests and in-browser sign-in were not run yet: they need
  `VITE_SUPABASE_PUBLISHABLE_KEY` (apps/web/.env) and `SUPABASE_SERVICE_ROLE_KEY`
  (apps/server/.env), and in CI a dedicated Supabase project + the `CI_*` GitHub secrets.
- After "sign out everywhere", an already-issued access token stays valid until it expires
  (Supabase JWTs are stateless) — set the JWT expiry to 15 min. Sockets re-check at each
  reconnect/ticket.
- Ownership transfer and org (team) management UI are not built; a board's owner cannot leave it.
- Test users created by server/E2E tests are deleted afterwards, but their personal
  organizations remain in the dev database (no FKs to cascade). Harmless.
- Trash purge endpoint exists but nothing calls it yet (Render Cron Job in Phase 13).
- Thumbnails update only when someone edits in a browser; boards edited only by API/tests
  keep no thumbnail.

## Later

- Phase 5: share rooms across instances via Redis pub/sub; `render.yaml` already says 2
  instances; allocate `seq` safely across instances.
- Phase 8: replay = nearest `board_snapshots` row + `board_update_archive`/`board_updates` rows
  after it.
- Phase 10: retention limits for archived history per plan.
- Nice-to-have (unscheduled): orthogonal arrow routing, nested groups, arrow label drag.
- Phase 10: team organizations (members, admins), ownership transfer, per-plan limits.
- Phase 13: Render Cron Job calling `POST /internal/purge-trash` daily with `CRON_SECRET`;
  set `TRUST_PROXY=1` on Render so rate limits see real client IPs.
- Phase 11: prerender public pages (landing, pricing, templates, docs, legal) at build time.
- Phase 12: Sentry + PostHog, security headers in `vercel.json`, audit logging.
- Phase 13: production migrations via Render `preDeployCommand` (the migrate script currently runs
  through `tsx`, a dev dependency — bundle it or install dev deps on Render); real staging/prod
  services; `CORS_ALLOWED_ORIGIN_PATTERN` for this project's Vercel previews.
