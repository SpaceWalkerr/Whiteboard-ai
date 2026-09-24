# Whiteboard.ai — Claude Code Build Kit

A collaborative system-design whiteboard with an AI that reviews your architecture.
Built phase by phase with Claude Code, deployed, and sold on subscription.

---

## 0. How to use this kit (read first)

1. Create an empty folder `whiteboard-ai`, run `git init`, open it in Claude Code.
2. The repo root already has `CLAUDE.md`, `SPEC.md` and `PROGRESS.md` — Claude Code reads
   CLAUDE.md automatically every session and keeps PROGRESS.md updated.
3. Run the **phase prompts in Section 3 one at a time**, in order. For each phase:
   - Paste the prompt. Claude Code will plan first and wait — read the plan, correct it, then say "go".
   - When it finishes, **check the acceptance criteria yourself** (run the app, click around).
   - Only when every box passes: commit, run `/clear`, start the next phase.
4. Never paste two phases at once. Never skip the acceptance checks. If a phase goes badly,
   `git reset --hard` to the last good commit and re-run it with a correction.

**Realistic timeline:** 10–14 weeks solo, part time. Phases 0–5 (~4–5 weeks) give you a solid,
demo-able multiplayer product — enough for hackCBS (31 Oct – 1 Nov 2026) and your portfolio.
Phases 6–14 turn it into something people pay for.

> ⚠️ Hackathon rule check: many hackathons forbid code written before the event. If you enter
> one, build phases 0–5 beforehand as an open-source project, and build the AI review (phases 6–7)
> on-site — confirm the rules first.

> ⚠️ Name check: "Whiteboard.ai" is a working title. Check domain + trademark availability before
> you buy anything (alternatives: Blueprint, SketchSD, Archboard). Rename in one place: `SPEC.md`.

---

## 1. `CLAUDE.md` and 2. `SPEC.md`

These now live as real files at the repo root — they are the source of truth (stack: React + Vite
on Vercel, Node on Render, Supabase for Postgres/Auth/Storage, Render Key Value for Redis).
Edit those files, not this document.

---

## 3. Phase prompts (paste ONE at a time)

Every phase prompt starts with the same line, already included below:
*"Read CLAUDE.md, SPEC.md and PROGRESS.md. We are on Phase N. Plan first and wait for my approval."*

---

### Phase 0 — Foundation (repo, tooling, CI)

```
Read CLAUDE.md, SPEC.md and PROGRESS.md. We are on Phase 0. Plan first and wait for my approval.

Goal: an empty but production-grade monorepo that every later phase builds on.

Build:
- pnpm + Turborepo monorepo: apps/web (React + Vite + React Router + Tailwind + shadcn/ui),
  apps/server (Node + Fastify + ws, REST and WebSocket on one port), packages/shared
  (types, zod schemas, env loader, Drizzle schema), packages/graph (empty for now),
  packages/config (eslint, tsconfig, prettier presets).
- TypeScript strict, ESLint, Prettier, lint-staged + husky pre-commit.
- packages/shared/env: zod-validated env loading used by both apps; complete .env.example.
- Local infra: Supabase CLI (`supabase start`) for Postgres + Auth + Storage, and
  docker-compose for Redis 7. `pnpm dev` starts web + server. Document the one-time setup.
- Drizzle set up in packages/shared/db with a first migration: a `profiles` table keyed by the
  Supabase auth user id. Enable RLS on it (no policies) and add a test that fails if ANY table
  in `public` has RLS disabled.
- apps/server: `/healthz` (liveness) and `/readyz` (checks Postgres + Redis) endpoints; pino
  logging; CORS allowlist from env; graceful shutdown on SIGTERM.
- apps/web: a placeholder home page that calls the server's /healthz and shows the result
  (proves VITE_API_URL + CORS work). vercel.json with SPA rewrites.
- render.yaml Blueprint stub describing the web service (build/start commands, health check,
  region singapore) — deployment itself happens in Phase 13.
- Vitest configured in every package with one real test each. Playwright configured with one
  smoke test that loads the home page.
- GitHub Actions CI: install (with cache), lint, typecheck, unit tests, build, Playwright smoke.
- README: what the project is, prerequisites, how to run locally, repo layout.

Acceptance criteria (I will check):
- [ ] Fresh clone → `pnpm i && supabase start && docker compose up -d && pnpm dev` works with
      no manual steps except copying the .env.example files.
- [ ] Removing a required env var makes the app fail at boot with a clear message.
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass; CI is green on a pushed branch.
- [ ] `curl localhost:<server-port>/readyz` returns 200 with DB + Redis up and 503 with Redis stopped.
```

---

### Phase 1 — Canvas editor (single user, Yjs-backed)

```
Read CLAUDE.md, SPEC.md and PROGRESS.md. We are on Phase 1. Plan first and wait for my approval.

Goal: a polished single-user whiteboard whose state already lives in a Yjs document, so
multiplayer in Phase 2 is only a transport change.

Build:
- Board data model in packages/shared: a zod schema for every shape type (base fields: id, type,
  x, y, w, h, rotation, zIndex, style, createdBy, updatedAt) including the system-design shapes
  from SPEC.md and arrows (fromShapeId, toShapeId, anchor points, label, edgeType).
- Y.Doc layout: Y.Map<shapeId, Y.Map> for shapes + a Y.Array for z-order + board meta map.
  Write a small typed wrapper (createShape, updateShape, deleteShapes, transact) — UI code never
  touches raw Yjs.
- react-konva canvas at /board/local: infinite pan (space+drag, trackpad) and zoom (ctrl/cmd+wheel,
  pinch), grid background, viewport culling so only visible shapes render.
- Tools: select, rectangle, ellipse, text, sticky note, freehand, arrow, + system-design shape
  palette with icons. Arrows bind to shapes and re-route when shapes move.
- Select/multi-select (marquee + shift), move, resize, rotate, group/ungroup, align, duplicate,
  delete, copy/paste (including between boards via clipboard JSON), snapping + smart guides.
- Undo/redo with Y.UndoManager scoped to the local user's origin.
- Keyboard shortcuts with a "?" cheat-sheet dialog. Right-click context menu. Properties panel
  for the selected shape (label, colour, database type, etc.).
- Export board as PNG and SVG.

Tests:
- Unit: shape schema validation, the Y.Doc wrapper, arrow re-binding math, undo/redo.
- Playwright: draw a service and a database, connect them with an arrow, move the service,
  assert the arrow still connects; undo restores the previous position.
- Performance check: a script that generates 2,000 shapes; panning stays smooth (report FPS).

Acceptance criteria:
- [ ] I can draw a small architecture (client → LB → 2 services → DB + cache) quickly using only
      the keyboard shortcuts and the palette.
- [ ] Arrows stay attached while shapes move/resize.
- [ ] Undo/redo works for every action. 2,000-shape board pans at ~60 fps.
```

---

### Phase 2 — Real-time sync server

```
Read CLAUDE.md, SPEC.md and PROGRESS.md. We are on Phase 2. Plan first and wait for my approval.

Goal: our own Yjs WebSocket sync server; multiple browsers edit the same board live.

Build (apps/server, sync module):
- WebSocket endpoint /rooms/:boardId implementing the y-protocols sync protocol (sync step 1/2,
  updates) and the awareness protocol. One in-memory Y.Doc per active room, created on first
  join, evicted (after persisting in Phase 3) when the last client leaves + a grace period.
- Message size limit (e.g. 1 MB), per-connection rate limit (messages/sec), heartbeat ping/pong,
  dead-connection cleanup, backpressure handling (drop/close slow consumers safely).
- Metrics: active rooms, connections, messages/sec, update bytes — exposed at /metrics
  (Prometheus format).
- Temporary auth: accept any connection for now, but structure the code so Phase 4 can insert
  a verifyToken(boardId, token) → role check before the socket is accepted.

Build (apps/web):
- A provider hook that connects the board's Y.Doc to the sync server with exponential-backoff
  reconnect and a connection-status indicator (connected / reconnecting / offline).
- Live cursors (name + colour), presence avatars in the header, remote selection outlines,
  "follow user" mode (my viewport follows theirs).

Tests:
- Integration: two in-process Yjs clients connect to a test server, make concurrent conflicting
  edits, and converge to the same state.
- Playwright with TWO browser contexts: user A draws a shape → appears for user B; B moves it →
  moves for A; cursors visible to each other.

Acceptance criteria:
- [ ] Two browser windows (one incognito) edit the same board live; cursors are visible.
- [ ] Kill the network in one window (DevTools offline), edit in both, reconnect → both converge.
- [ ] Restarting the sync server makes clients show "reconnecting" and then recover
      (data loss on restart is acceptable ONLY in this phase; Phase 3 fixes it).
```

---

### Phase 3 — Persistence + offline

```
Read CLAUDE.md, SPEC.md and PROGRESS.md. We are on Phase 3. Plan first and wait for my approval.

Goal: boards are never lost, load fast, and work offline.

Build:
- Tables: boards (id, owner, title, created/updated, deleted_at), board_updates (board_id, seq,
  update bytea, client_id, created_at), board_snapshots (board_id, seq_upto, state bytea,
  created_at). Drizzle migrations.
- Write path: every incoming update is appended to board_updates (batched, ≤ 50 ms) BEFORE it is
  acknowledged/broadcast as durable. Document the exact durability guarantee in PROGRESS.md.
- Compaction: when a room has > N updates since the last snapshot (or on room eviction), merge
  them into a new snapshot and delete the compacted updates in one transaction.
- Load path: latest snapshot + updates after it. Measure load time for a 2,000-shape board.
- Graceful shutdown: on SIGTERM stop accepting connections, flush all pending updates, snapshot
  active rooms, then exit.
- Client offline support with y-indexeddb: boards open offline from local cache and sync on
  reconnect. Show a clear "offline — changes will sync" banner.
- Keep the full update history available (retain compacted history in an archive table or keep
  periodic snapshots) because Phase 8 session replay needs to reconstruct the board over time.
  Choose an approach, justify it in PROGRESS.md.

Tests:
- Integration: write 10,000 updates → compaction runs → reloaded doc equals the original state.
- Crash test: kill -9 the sync server mid-editing → restart → no acknowledged edit is lost.

Acceptance criteria:
- [ ] Draw, restart the sync server (normal and kill -9), reload: everything is still there.
- [ ] Open a board, go offline, edit, close the tab, reopen online: offline edits sync up.
- [ ] Large board (2,000 shapes) loads in < 1.5 s locally.
```

---

### Phase 4 — Auth, workspaces, boards dashboard, sharing & permissions

```
Read CLAUDE.md, SPEC.md and PROGRESS.md. We are on Phase 4. Plan first and wait for my approval.

Goal: real users, real ownership, and permissions enforced on the WebSocket, not just in the UI.

Build:
- Supabase Auth in apps/web: email magic link (custom SMTP = Resend, configured in Supabase),
  Google and GitHub OAuth, session refresh, sign-out-everywhere. apps/server verifies the
  access token via the Supabase JWKS on every REST request.
- On first sign-in, apps/server creates the profile row and a personal workspace (our
  organizations table — Team workspaces later).
- Tables: organizations, memberships (role: owner/admin/member), board_members (role:
  owner/editor/viewer), share_links (token hash, role, expires_at, revoked_at), invites,
  audit_logs.
- Dashboard: my boards, shared with me, recent, folders, search, create/rename/duplicate/delete
  (soft delete + trash with 30-day restore), board thumbnails (render on save → private Supabase
  Storage bucket, served via short-lived signed URLs).
- Sharing dialog: invite by email with role, copy share link (viewer/editor), revoke links,
  public read-only toggle, list members + change roles.
- Sync auth: the web app asks apps/server for a short-lived (5 min) room ticket — a JWT signed
  with our own secret, {userId, boardId, role} — issued only after checking the Supabase token
  and the board role. The WebSocket upgrade verifies the ticket and the Origin header before
  accepting the socket, rejects viewers' write messages
  server-side, and re-checks on reconnect. Removing a member disconnects them immediately
  (publish a revocation event).
- Rate limit auth endpoints and invite sending.

Tests:
- Authorization matrix tests: for each role × action (read, write, share, delete) assert
  allowed/denied at the API AND at the WebSocket.
- A viewer who crafts raw Yjs update messages cannot change the board (integration test).
- Playwright: sign up (magic link captured in test mode), create board, invite second user,
  second user edits.

Acceptance criteria:
- [ ] A viewer cannot edit even by sending messages manually from the console.
- [ ] Revoking a share link or removing a member kicks their live session within seconds.
- [ ] Every share/role/delete action appears in audit_logs.
```

---

### Phase 5 — Horizontal scaling + load testing

```
Read CLAUDE.md, SPEC.md and PROGRESS.md. We are on Phase 5. Plan first and wait for my approval.

Goal: run 2+ sync instances; clients connected to different instances see each other.

Build:
- Redis pub/sub channel per room: an instance publishes local updates/awareness and applies
  remote ones, tagging messages with an instance ID to avoid echo loops.
- Persistence ownership: exactly one writer per room at a time, or idempotent writes — choose,
  justify in PROGRESS.md, and make it safe when an instance dies (lease with TTL in Redis).
- Revocation events (Phase 4) also travel over Redis.
- docker-compose.scale.yml: 2 apps/server instances behind nginx (round-robin, no sticky
  sessions) — this mirrors Render running 2 instances behind its load balancer.
- k6 WebSocket load test scripts: (a) 50 editors in one room, (b) 2,000 connections across
  200 rooms. Record p50/p95 edit-propagation latency, CPU, memory, and error rate.
- Write docs/scaling.md with the architecture diagram (Mermaid), the numbers, and the bottlenecks
  found.

Tests:
- Integration: client A on instance 1, client B on instance 2 → edits and cursors propagate.
- Kill instance 1 → its clients reconnect to instance 2 with no lost acknowledged edits.

Acceptance criteria:
- [ ] Two windows forced onto different instances collaborate normally.
- [ ] docs/scaling.md contains real measured numbers that meet SPEC.md targets (or explains
      exactly why not and what to change).
```

---

### Phase 6 — Canvas → graph + deterministic rules engine

```
Read CLAUDE.md, SPEC.md and PROGRESS.md. We are on Phase 6. Plan first and wait for my approval.

Goal: turn any board into a typed architecture graph and find obvious problems WITHOUT AI.
This is the foundation the AI review stands on (and it keeps AI costs down).

Build (packages/graph, pure TypeScript, no I/O):
- extractGraph(doc) → { nodes: [{id, kind, label, props}], edges: [{id, from, to, edgeType,
  label}] }. Handle arrows attached to groups, unlabeled shapes, dangling arrows, and plain
  shapes that are not system components (ignored, but reported).
- A rules engine where each rule is a small pure function returning findings
  { ruleId, severity: info|warning|critical, title, explanation, shapeIds[], suggestion }.
  Initial rules: single database with no replica (SPOF); service with no load balancer in front
  when >1 instance; read-heavy path with no cache; synchronous call chain deeper than N;
  queue without a dead-letter queue / retry path; client talking directly to the database;
  no CDN in front of static/object storage; cycle of synchronous calls; disconnected component.
- UI: "Check design" button → findings panel; clicking a finding highlights and zooms to its
  shapes on the canvas.

Tests:
- Every rule has positive and negative fixture boards. Property test: extractGraph never throws
  on randomly generated boards.

Acceptance criteria:
- [ ] Drawing a single DB with no replica produces a critical SPOF finding that highlights the DB.
- [ ] Fixing the design (adding a replica) makes the finding disappear on re-check.
```

---

### Phase 7 — AI design review (Claude API) + usage quotas

```
Read CLAUDE.md, SPEC.md and PROGRESS.md. We are on Phase 7. Plan first and wait for my approval.

Goal: a genuinely useful AI review that points at specific shapes, with costs under control.

Build:
- POST /api/boards/:id/review (auth + editor/viewer role check + plan quota check).
  Input to the model: the extracted graph (NOT raw canvas JSON), rule-engine findings, optional
  problem statement (e.g. "Design a URL shortener, 100M URLs/day"), and user-stated requirements.
- Use `claude-sonnet-5` with tool use / structured output so the response is validated by a zod
  schema: overall summary, score per dimension (scalability, reliability, data design, security,
  cost), findings [{severity, title, explanation, shapeIds[], suggestion}], and follow-up
  questions an interviewer would ask. Reject/repair output that references unknown shape IDs.
- Stream progress to the UI; render findings as numbered pins on the canvas + a side panel.
  Reviews are saved (reviews table) and viewable later; show a diff vs the previous review.
- Live hints (Pro+): `claude-haiku-4-5-20251001`, debounced (e.g. 8 s after the last change,
  only if the graph changed meaningfully), max N per hour, dismissible.
- Cost control: prompt caching for the static system prompt, max tokens, per-user monthly quota
  from the entitlements table, per-request token + cost logging (ai_usage table), a global daily
  spend kill-switch via env var, and graceful "quota reached — upgrade" UX.
- Prompt-injection safety: shape labels are untrusted user text — pass them as data, never as
  instructions; the model has no tools that act on the board.
- An eval script: 15 fixture boards with known flaws → run the review → report which expected
  flaws were caught. Keep it in the repo; re-run whenever the prompt changes.

Acceptance criteria:
- [ ] A review of a flawed design catches the planted issues and every finding highlights the
      right shapes.
- [ ] Exceeding the Free quota shows the upgrade prompt; the API returns 402 without calling Claude.
- [ ] ai_usage shows tokens and cost for every call; the kill-switch blocks calls when set.
- [ ] Eval script passes ≥ 12/15.
```

---

### Phase 8 — Interview mode + session replay

```
Read CLAUDE.md, SPEC.md and PROGRESS.md. We are on Phase 8. Plan first and wait for my approval.

Goal: the Team-plan feature that hiring teams pay for.

Build:
- "Start interview" on a board: roles (interviewer, candidate, observer), question bank
  (seed 20 classic prompts: URL shortener, chat app, news feed, rate limiter, ride sharing,
  file storage, notification system, …) with requirements and hints, a countdown timer visible
  to everyone, interviewer-only private notes (stored separately, never sent to candidates'
  sockets).
- Rubric scorecard (per dimension 1–4 + comments) → end interview → summary page with the AI
  review, the scorecard, and a shareable (auth-protected) link. PDF export.
- Session replay: reconstruct the board over time from the update history (Phase 3); timeline
  scrubber with play/pause/speed, markers for when AI reviews ran and when notes were written.

Tests:
- Private notes never appear in any message sent to a candidate connection (integration test).
- Replay at time T equals the board as it was at T (fixture-based test).

Acceptance criteria:
- [ ] I can run a full mock interview with a friend: start, draw, review, score, end, replay.
- [ ] The candidate cannot see interviewer notes by any means (UI or network tab).
```

---

### Phase 9 — End-to-end encrypted private rooms

```
Read CLAUDE.md, SPEC.md and PROGRESS.md. We are on Phase 9. Plan first and wait for my approval.

Goal: Pro+ users can create boards the server cannot read.

Build:
- On creation of a private board, generate an AES-GCM 256 key with WebCrypto in the browser;
  put it in the URL fragment (#key=…) so it is never sent to the server.
- Encrypt every Yjs update and awareness message client-side before sending; the sync server
  relays and stores opaque ciphertext only (it cannot compact by merging — design snapshotting
  for this case: e.g. clients periodically upload an encrypted full-state snapshot).
- Thumbnails, search and server-side export are disabled for private boards (show why in the UI).
- AI review in a private room: the CLIENT extracts the graph and sends only that, after an
  explicit per-review consent dialog. Nothing is stored server-side unless the user opts in.
- Key sharing UX: copy link with key; warn that losing the link = losing access.
- Write docs/security.md: threat model, what the server can and cannot see, and the limitations.

Tests:
- Integration: inspect what the server stores for a private board — assert it is not parseable
  as a Yjs update and contains no shape labels in plaintext.

Acceptance criteria:
- [ ] Two users collaborate in a private room normally.
- [ ] The database contains no readable board content for that room.
```

---

### Phase 10 — Billing & entitlements (Razorpay)

```
Read CLAUDE.md, SPEC.md and PROGRESS.md. We are on Phase 10. Plan first and wait for my approval.

Goal: people can pay; limits follow their plan; money logic is correct under retries and failures.

Build:
- A BillingProvider interface (createCheckout, cancel, changePlan, getSubscription,
  verifyWebhook) with a Razorpay Subscriptions implementation (test mode). Design it so a
  Merchant of Record (Lemon Squeezy/Paddle) can be added later for international customers.
- Tables: plans, subscriptions, entitlements (derived per org/user), billing_events
  (provider_event_id UNIQUE), invoices.
- Webhook endpoint: verify signature, store the event id first (duplicates become no-ops),
  process in a transaction, and fetch current subscription state from the provider instead of
  trusting event order. Handle: activated, charged, pending/halted (payment failed → 7-day
  grace period → downgrade to Free, boards kept read-only above the limit, never deleted),
  cancelled, plan changed, seat count changed (Team).
- Pricing page, upgrade/downgrade flows, billing settings (current plan, next charge, invoices,
  cancel), in-app upgrade prompts at every limit (boards, editors, AI reviews).
- Entitlement checks in ONE place (packages/shared/entitlements) used by web API AND sync server.
- Student offer (.edu/.ac.in email → Pro trial 3 months), coupon support.
- Emails: payment receipt, payment failed, grace-period reminder, downgraded.

Tests:
- Webhook tests: duplicate event, out-of-order events, invalid signature, failed payment → grace
  → downgrade, upgrade mid-cycle.
- Limits tests: Free user's 4th board is blocked at the API; 4th editor on a Free board is
  rejected at the sync server.

Acceptance criteria:
- [ ] In Razorpay test mode I can subscribe, see Pro features unlock, cancel, and see them lock
      at period end.
- [ ] Replaying the same webhook 5 times changes nothing after the first.
- [ ] No plan limit can be bypassed by calling the API or WebSocket directly.
```

---

### Phase 11 — Marketing site, docs & legal pages

```
Read CLAUDE.md, SPEC.md and PROGRESS.md. We are on Phase 11. Plan first and wait for my approval.

Goal: a public site that explains, converts, and satisfies payment-gateway requirements.

Build:
- All public pages are prerendered to static HTML at build time (React Router prerendering
  or an equivalent Vite SSG plugin) so they are indexable without JavaScript.
- Landing page: headline, 60-second demo video/GIF slot, how it works (draw → review → improve),
  interview-mode section, testimonials slot, pricing table (from the plans table, not hard-coded),
  FAQ, CTA. Fast (Lighthouse ≥ 90), responsive, dark mode, OG images per page.
- Public templates gallery (classic system designs as starting boards) — each template is an
  SEO landing page ("URL shortener system design diagram").
- Docs: getting started, shortcuts, sharing & permissions, AI review, interview mode, private
  rooms, billing FAQ.
- Legal & policy pages REQUIRED by Razorpay: Terms of Service, Privacy Policy, Refund &
  Cancellation Policy, Shipping/Delivery policy (digital service), Contact Us with a real
  email/address. Generate clear drafts and mark them "review with a professional before launch".
- Cookie consent that defaults to essential-only; PostHog loads only after consent.
- sitemap.xml, robots.txt, structured data, canonical URLs.

Acceptance criteria:
- [ ] Every page passes Lighthouse ≥ 90 (performance, accessibility, SEO) on mobile.
- [ ] All Razorpay-required pages exist and are linked from the footer.
```

---

### Phase 12 — Production hardening

```
Read CLAUDE.md, SPEC.md and PROGRESS.md. We are on Phase 12. Plan first and wait for my approval.

Goal: safe to put real users and money on it.

Do a full audit and fix everything found:
- Security: security headers + strict CSP, CSRF coverage, rate limits on every public endpoint
  and the WebSocket, input size limits, SSRF-safe URL handling, dependency audit, secrets scan,
  OWASP Top 10 walkthrough documented in docs/security.md.
- Observability: Sentry on web + sync (with release tags and source maps), structured logs with
  request IDs across web → sync, PostHog key events (signup, board_created, review_run,
  upgrade_started, upgrade_completed), an uptime monitor for web, sync /readyz and webhooks.
- Data: backups + point-in-time recovery verified by an actual restore drill (document steps),
  account deletion (30-day hard delete job), "export all my data" (JSON zip), data retention jobs.
- Admin panel (role-gated, audited): look up user/org, see plan & usage, extend trial, refund
  note, disable abusive account, view AI spend per day.
- Email flows: welcome, invite, magic link, receipts, failed payment, weekly "your designs"
  digest (opt-out).
- Performance: bundle analysis, code-split the canvas, image optimisation, DB indexes for every
  query in hot paths (EXPLAIN the top 10), N+1 check.
- Accessibility pass on app UI; keyboard-only walkthrough of core flows.
- Error pages: 404, 500, board-not-found, no-access (with "request access" button).

Acceptance criteria:
- [ ] docs/security.md and docs/runbook.md exist and are specific (not generic advice).
- [ ] A restore drill from backup has been performed and written up.
- [ ] Triggering an error in web and sync shows up in Sentry with a readable stack trace.
```

---

### Phase 13 — Deployment (staging + production)

```
Read CLAUDE.md, SPEC.md and PROGRESS.md. We are on Phase 13. Plan first and wait for my approval.

Goal: staging and production environments, deployed automatically from GitHub.

Build:
- Frontend (Vercel): project root apps/web, build with pnpm/Turborepo, SPA rewrites,
  environment variables for Production and Preview (staging API/WS URLs for previews),
  custom domain app.<domain>.
- Backend (Render, via render.yaml Blueprint): apps/server web service, region singapore,
  paid instance type, 2 instances, health check /readyz, pre-deploy command runs Drizzle
  migrations, graceful shutdown within Render's shutdown delay; Render Key Value (same region,
  internal URL only); Cron Jobs for maintenance tasks; custom domain api.<domain> (HTTPS + WSS).
- Database (Supabase): separate staging and production projects in ap-southeast-1; production
  on Pro with PITR enabled; Auth redirect URLs and OAuth apps configured per environment;
  custom SMTP (Resend); private Storage buckets.
- Razorpay live webhook → https://api.<domain>/webhooks/razorpay.
- GitHub Actions: PR → CI + Vercel preview; merge to main → deploy Render staging service
  (its pre-deploy step migrates the staging DB) → deploy Vercel staging → Playwright smoke against staging → manual approval → migrate prod → deploy prod.
  Migrations must be backward compatible (expand → migrate → contract); document the rule.
- Secrets management: every secret set in Vercel / Render / Supabase dashboards, none in the repo; a checklist of
  every env var per environment in docs/deploy.md.
- docs/runbook.md: how to deploy, roll back (Vercel instant rollback and Render rollback), restore the DB, rotate keys,
  handle an incident, turn on the AI kill-switch.
- Launch checklist in docs/launch.md: switch Razorpay to live mode, test a real ₹1 payment and
  refund, verify emails deliver (SPF/DKIM/DMARC), verify backups, verify Sentry/PostHog/uptime.

Acceptance criteria:
- [ ] Merging a PR deploys to staging automatically and to prod after my approval.
- [ ] Rolling back prod takes one command, documented and tested once.
- [ ] Two people on different networks collaborate on the production URL.
- [ ] A Render deploy (instance restart) during a live session loses no acknowledged edits.
```

---

### Phase 14 — Launch & first paying users (you, not Claude Code)

Not a coding phase — do these yourself:

- **Business setup:** complete Razorpay KYC (PAN, bank account, website with the policy pages),
  and ask a CA about GST registration and invoicing before you cross the threshold or sell abroad.
  Consider a Merchant of Record (Lemon Squeezy / Paddle) for international customers — they
  handle foreign tax for you.
- **Soft launch:** 20–30 students from your college and LinkedIn/X network on free Pro for a month
  in exchange for feedback. Watch PostHog funnels: signup → first board → first review → upgrade.
- **Content that sells it:** one public template + blog post per classic system-design question
  ("Design a URL shortener — interactive diagram + AI review"). This is your SEO engine.
- **Launch:** Product Hunt, Hacker News "Show HN", r/developersIndia, r/cscareerquestions,
  LinkedIn post with the demo video, college placement cells and coding clubs, bootcamps
  (offer Team plan discounts to instructors).
- **Portfolio + hackathons:** add it to `projects.ts`, pin the repo (or keep the core sync engine
  open source and the SaaS private), and write the blog post "Building a multiplayer whiteboard:
  CRDTs, Redis fan-out and end-to-end encryption".

---

## 4. Useful Claude Code habits for this build

- **Plan mode first** (Shift+Tab) for every phase, as the prompts require.
- **`/clear` between phases.** CLAUDE.md + SPEC.md + PROGRESS.md carry the context; a clean
  session is cheaper and more accurate than a long one.
- **When it drifts:** "Stop. Re-read CLAUDE.md. You changed X which is out of scope for this
  phase — revert it."
- **When stuck on a bug:** ask it to write a failing test that reproduces the bug first, then fix.
- **Review before commit:** run `/code-review` on the diff at the end of each phase, especially
  phases 4, 7, 9 and 10 (permissions, AI, crypto, money).
- **Commit per phase** with a clear message, and tag `v0.N` so you can always roll back.
