# Whiteboard.ai

A real-time collaborative whiteboard for system design, where an AI reviews your architecture
diagram like a senior engineer — for interview practice, live interviews and team design reviews.

See [SPEC.md](SPEC.md) for the product, [CLAUDE.md](CLAUDE.md) for engineering rules and
architecture, and [PROGRESS.md](PROGRESS.md) for where the build currently stands.

## Architecture at a glance

| Part                                 | Where it runs         | Code                     |
| ------------------------------------ | --------------------- | ------------------------ |
| React SPA                            | Vercel                | `apps/web`               |
| REST API + WebSocket sync (1 port)   | Render (2+ instances) | `apps/server`            |
| Postgres, Auth, file Storage         | Supabase              | `packages/shared/src/db` |
| Redis (pub/sub, rate limits, leases) | Render Key Value      | — (production only)      |

The browser only talks to Supabase for sign-in; all data goes through `apps/server`.

## Prerequisites

- **Node.js 22** (`.nvmrc`; 22.12 or newer)
- **pnpm 10** — `corepack enable` (or `npm i -g pnpm@10`). The exact version is pinned in
  `package.json#packageManager`.
- A **Supabase project for development** (free tier is fine) in region
  `ap-southeast-1` (Singapore). Keep it separate from staging/production.

`pnpm dev` needs nothing else — no Docker, no local Postgres or Redis. **`pnpm test`**
additionally needs a Redis for the multi-instance tests (`TEST_REDIS_URL`, default
`redis://127.0.0.1:6379`): run `redis-server` if you have it, or the scale stack's Redis
(`docker compose -f docker-compose.scale.yml up -d redis`). The tests fail loudly without it.
Load/scale testing tools (Redis, nginx, k6 or Docker) are described in
[docs/scaling.md](docs/scaling.md).

## One-time setup

```bash
pnpm install
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env
```

Then fill in, from your Supabase dev project:

- `apps/server/.env` → `DATABASE_URL`: dashboard → **Connect** → **Session pooler**, copy the
  URI, put in your database password and keep `?sslmode=require` at the end.
- `apps/server/.env` → `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (**Project Settings → API
  Keys**, the secret/service_role key), and `ROOM_TICKET_SECRET`
  (`openssl rand -base64 48`).
- `apps/web/.env` → `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (the
  publishable/anon key — public by design; RLS keeps our tables unreadable through it).

In the Supabase dashboard → **Authentication**:

- **URL Configuration**: Site URL `http://localhost:5173`, redirect URL
  `http://localhost:5173/auth/callback`.
- **Sign In / Providers**: enable Email (magic link), Google and GitHub. Each OAuth app's
  callback URL is `https://<project-ref>.supabase.co/auth/v1/callback`.
- **JWT**: use asymmetric signing keys (the server verifies tokens with the JWKS) and a 15-minute
  access-token expiry.

In development invite emails are not sent: the server logs the invite link
(`EMAIL_TRANSPORT=log`).

Only if you want to run the E2E test locally:
`pnpm --filter @whiteboard/web exec playwright install chromium`.

## Running locally

```bash
pnpm dev                   # applies DB migrations to Supabase, then runs web (5173) + server (4000)
```

Open http://localhost:5173 — the home page shows **Server: ok** when the web app can reach the
API. Check readiness with `curl -i localhost:4000/readyz` (200 when the database is reachable,
503 otherwise). Stop with `Ctrl+C`.

Redis is optional in development: leave `REDIS_URL` empty and `/readyz` checks only Postgres.
It is required in production (the server refuses to boot without it there).

## Everyday commands

| Command                              | What it does                                                         |
| ------------------------------------ | -------------------------------------------------------------------- |
| `pnpm dev`                           | Migrate the local DB, then run web + server with hot reload          |
| `pnpm lint`                          | ESLint (type-aware) in every package                                 |
| `pnpm typecheck`                     | `tsc --noEmit` in every package                                      |
| `pnpm test`                          | Vitest in every package (the RLS test uses `DATABASE_URL`)           |
| `pnpm test:e2e`                      | Playwright E2E tests (starts the server + a built web app itself)    |
| `pnpm --filter @whiteboard/web perf` | Pans a 2,000-shape board and reports FPS (local only)                |
| `pnpm build`                         | Production builds (`apps/web/dist`, `apps/server/dist`)              |
| `pnpm db:generate`                   | Generate a new SQL migration from the Drizzle schema                 |
| `pnpm db:migrate`                    | Apply pending migrations to `DATABASE_URL` (from `apps/server/.env`) |
| `pnpm format`                        | Prettier                                                             |
| `pnpm scale:local` / `pnpm scale:up` | 2 server instances + nginx + Redis, natively / with Docker           |
| `pnpm load:seed a\|b\|cleanup`       | Seed (or remove) load-test users, boards and room tickets            |

A pre-commit hook (husky + lint-staged) lints and formats staged files.

### Accounts, dashboard and sharing

Sign in at `/sign-in` (magic link, Google or GitHub). `/app` is the dashboard: your boards,
boards shared with you, recent boards, folders, search and a 30-day trash. On a board, owners
click **Share** to invite people by email (editor/viewer), create share links, make the board
publicly viewable, and change or remove members. Viewers see the board read-only — the server
rejects their edits too. Removing someone or revoking a link disconnects them within seconds.
Every share, role and delete action is recorded in `audit_logs`.

### The board (`/board/:boardId`)

Click **New board** on the dashboard: everyone with access edits the same
board live, with cursors and presence. Board state is a Yjs document
(`packages/shared/src/board`) synced through our own WebSocket server at `/rooms/:boardId`
(`apps/server/src/sync`, client in `packages/shared/src/sync`). Every edit is written to
Postgres within ~50 ms (the status turns **Saved** once it is committed); boards are also kept
in the browser (IndexedDB) and the app is cached by a service worker, so boards open and can
be edited offline and sync when the connection returns. See PROGRESS.md for the exact
durability guarantee. Press **?** on the board for every keyboard shortcut; **/**
inserts a system-design shape by name and connects it from the selected shape.

Server metrics (Prometheus) are at `GET /metrics` (bearer `METRICS_TOKEN` when set).

Code map: `apps/web/src/features/board/` — `controller.ts` (all editing commands),
`interaction/pointer.ts` (pointer gestures), `canvas/` (react-konva rendering), `ui/` (toolbar,
palette, properties, dialogs), `export/` (SVG/PNG). UI code never touches Yjs directly; it goes
through `BoardStore`.

### Database migrations

Drizzle migrations in `packages/shared/src/db/migrations` are the **only** source of truth.
Never change the schema in the Supabase dashboard (table editor / SQL editor). To change the
schema: edit `packages/shared/src/db/schema.ts`, run `pnpm db:generate --name <what_changed>`,
review the SQL, then `pnpm db:migrate`. Every new table must `.enableRLS()` — the test suite
fails if any table in `public` has RLS disabled.

## Repo layout

```
apps/
  web/            React + Vite SPA (React Router, Tailwind, shadcn/ui, TanStack Query)
  server/         Fastify REST + ws WebSocket on one port, pino logs, graceful shutdown
packages/
  shared/         zod env loader (src/env), shared schemas (src/schemas), Drizzle schema +
                  migrations (src/db). Browser code may import only env/web, env and schemas.
  graph/          Canvas → graph conversion and rules engine (Phase 6; empty for now)
  config/         Shared ESLint, TypeScript and Prettier presets
loadtest/         k6 scenarios, Node load generator and latency probe (docs/scaling.md)
infra/scale/      nginx config + native runner for the 2-instance scale stack
docker-compose.scale.yml  The same stack in Docker (scale/load tests only)
docs/             Design notes (scaling.md: multi-instance sync, measurements)
render.yaml       Render Blueprint (stub until Phase 13)
.github/workflows CI: lint, typecheck, build, tests (Supabase Postgres image), Playwright smoke
```

## Environment variables

Each app validates its environment with zod at startup (`packages/shared/src/env`) and refuses
to boot — or the web build fails — with a message naming every missing or invalid variable.
`apps/server/.env.example` and `apps/web/.env.example` document every variable. Only public
`VITE_*` values may go in the web app.
