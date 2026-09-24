# Whiteboard.ai — Engineering Rules

You are building a production SaaS that real customers will pay for. Correctness, security and
data safety matter more than speed or feature count.

## Always
- Read SPEC.md and PROGRESS.md at the start of every session.
- Plan before coding: list the files you will create/change and the tests you will write, then
  STOP and wait for my approval.
- Work only on the current phase. If you notice something for a later phase, note it in
  PROGRESS.md under "Later" — do not build it.
- After implementing: run `pnpm lint && pnpm typecheck && pnpm test` and fix every failure.
  Never disable a lint rule, skip a test, or use `any`/`@ts-ignore` to make checks pass.
- Update PROGRESS.md: what was done, decisions made (with the reason), known issues.
- Tell me exactly how to verify the phase manually (commands + what I should see).
- Do not commit; I commit after I verify.

## Architecture (3 deployables)
```
Browser ──HTTPS──▶ Vercel: apps/web (React SPA, static)
   │
   ├──HTTPS (REST, Bearer JWT)──▶ Render: apps/server (Node) ──▶ Supabase Postgres
   └──WSS  (Yjs sync, JWT)──────▶ Render: apps/server (same service) ──▶ Render Key Value (Redis)
   └──Supabase Auth only (sign-in, session refresh) ──▶ Supabase
```
- The frontend NEVER reads or writes the database directly. It uses Supabase only for auth.
  All data goes through apps/server.
- apps/server is ONE Render web service that serves the REST API and the WebSocket sync
  endpoint on the same port. It must run correctly as 2+ instances (state shared via Redis).

## Stack (do not substitute without asking)
- Monorepo: pnpm workspaces + Turborepo, TypeScript strict everywhere, Node 22 LTS.
- apps/web: React + Vite, React Router, Tailwind CSS, shadcn/ui, TanStack Query for server state.
  Public pages (landing, pricing, templates, docs, legal) are prerendered to static HTML at
  build time for SEO; app routes (/app/*, /board/*) are client-rendered.
- apps/server: Node + Fastify (REST) + `ws` + `yjs` + `y-protocols` — our own sync server
  (NOT Hocuspocus, NOT Liveblocks, NOT Supabase Realtime, NOT tldraw sync). Use Hocuspocus
  only as a design reference.
- Canvas: react-konva. Board state lives in a Yjs Y.Doc from day one.
- Database: Supabase PostgreSQL + Drizzle ORM + drizzle-kit migrations (never edit the DB by hand
  or in the Supabase dashboard; the migrations in the repo are the source of truth).
- Auth: Supabase Auth (email magic link + Google + GitHub OAuth). The frontend sends the Supabase
  access token as `Authorization: Bearer`; apps/server verifies it with the project's JWKS
  (asymmetric signing keys) — never trust a user id sent in a request body.
  Organizations, memberships and board roles are OUR tables, not Supabase features.
- Cache / cross-instance messaging / rate limits / leases: Redis via ioredis
  (Render Key Value in production, docker Redis locally).
- File storage (thumbnails, exports): Supabase Storage, private buckets, accessed only by
  apps/server with the service key; the browser gets short-lived signed URLs.
- Background jobs (compaction sweeps, hard deletes, digests): Render Cron Jobs that call
  protected internal endpoints, or in-process timers guarded by a Redis lease — never both.
- Validation: zod at every boundary (HTTP bodies, env vars, WebSocket messages, AI output).
- AI: Anthropic Claude API via the official `@anthropic-ai/sdk`, in apps/server only.
  Models: `claude-sonnet-5` for full design reviews, `claude-haiku-4-5-20251001` for live hints.
- Email: Resend + React Email (also configured as Supabase Auth's custom SMTP).
  Errors: Sentry. Product analytics: PostHog. Logs: pino (JSON).
- Tests: Vitest (unit/integration), Playwright (E2E, including two-browser collaboration), k6 (load).

## Environments & deployment
- Local: docker-compose (Postgres 16, Redis 7) + the Supabase CLI (`supabase start`) for local
  Auth/Storage. `pnpm dev` runs web + server.
- Frontend → Vercel (project root apps/web). `vercel.json` rewrites all non-file routes to
  index.html. Only `VITE_*` public values in the frontend: API URL, WS URL, Supabase URL,
  Supabase publishable/anon key, Sentry DSN, PostHog key.
- Backend → Render (render.yaml Blueprint in the repo): web service for apps/server with health
  check `/readyz`, 2 instances, paid instance type (the free tier sleeps and drops WebSockets),
  graceful shutdown on SIGTERM within Render's shutdown window; Render Key Value in the SAME
  region; Cron Jobs as needed.
- Database → Supabase, in the SAME region as Render (Singapore: Render `singapore`,
  Supabase `ap-southeast-1`). Every cross-region query adds ~60 ms.
- Separate Supabase projects and Render services for staging and production.

## Supabase rules (security-critical)
- Enable Row Level Security on EVERY table in the `public` schema, with no policies for the
  `anon`/`authenticated` roles, so the public Supabase API (PostgREST) can never read our data
  even though the anon key is public. A migration test asserts RLS is on for every table.
- The service-role key and the database password exist only in apps/server env on Render.
- apps/server connects through the Supabase connection pooler (Supavisor): session mode for the
  long-running server and for migrations. If transaction mode (port 6543) is ever used, disable
  prepared statements.
- Use Supabase Pro in production (daily backups; enable PITR before launch). Free projects pause
  when idle and have no backups.

## Code rules
- Shared types and zod schemas live in packages/shared; never duplicate a type across apps.
- Env vars are validated at startup with zod (packages/shared/env); the app refuses to boot
  with a missing/invalid var. Keep `.env.example` complete and up to date (one per app).
- CORS on apps/server: explicit allowlist (production domain, staging domain, Vercel preview
  URL pattern for this project only). WebSocket upgrades check the Origin header too.
- Every server entry point (REST route AND WebSocket connection) checks authentication AND
  authorization (role on that board/org).
- Every mutation that touches money, permissions or deletion writes an audit_log row.
- No secrets in client code, logs, or error messages. The Anthropic key never reaches the browser.
- Errors: typed error classes, user-safe messages, full detail to Sentry/logs only.
- Prefer boring, well-understood solutions. Small functions, clear names, comments explain "why".
- Accessibility: keyboard reachable UI, labelled controls, visible focus, WCAG AA contrast.
