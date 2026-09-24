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

Nothing else is needed locally — no Docker, no local Postgres or Redis.

## One-time setup

```bash
pnpm install
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env
```

Then set `DATABASE_URL` in `apps/server/.env`: in the Supabase dashboard open your dev project →
**Connect** → **Session pooler**, copy the URI, put in your database password and keep
`?sslmode=require` at the end. Everything else in the example files works as is.

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

| Command            | What it does                                                         |
| ------------------ | -------------------------------------------------------------------- |
| `pnpm dev`         | Migrate the local DB, then run web + server with hot reload          |
| `pnpm lint`        | ESLint (type-aware) in every package                                 |
| `pnpm typecheck`   | `tsc --noEmit` in every package                                      |
| `pnpm test`        | Vitest in every package (the RLS test uses `DATABASE_URL`)           |
| `pnpm test:e2e`    | Playwright smoke test (starts server + built web app itself)         |
| `pnpm build`       | Production builds (`apps/web/dist`, `apps/server/dist`)              |
| `pnpm db:generate` | Generate a new SQL migration from the Drizzle schema                 |
| `pnpm db:migrate`  | Apply pending migrations to `DATABASE_URL` (from `apps/server/.env`) |
| `pnpm format`      | Prettier                                                             |

A pre-commit hook (husky + lint-staged) lints and formats staged files.

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
render.yaml       Render Blueprint (stub until Phase 13)
.github/workflows CI: lint, typecheck, build, tests (Supabase Postgres image), Playwright smoke
```

## Environment variables

Each app validates its environment with zod at startup (`packages/shared/src/env`) and refuses
to boot — or the web build fails — with a message naming every missing or invalid variable.
`apps/server/.env.example` and `apps/web/.env.example` document every variable. Only public
`VITE_*` values may go in the web app.
