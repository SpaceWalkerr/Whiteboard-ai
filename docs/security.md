# Security

How Whiteboard.ai protects accounts, boards and payments: the trust boundaries, an OWASP Top 10
(2021) walkthrough against this codebase, the browser and HTTP protections, rate and size
limits, dependencies and secrets, and the end-to-end encryption of private boards.

Last full audit: Phase 12a (2026-09-28). Every claim below names the code that enforces it and
the test that proves it. When you change one of those places, update this file.

## Trust boundaries

```
Browser (untrusted) ──HTTPS, Bearer JWT──▶ apps/server REST (Fastify) ──▶ Postgres (Supabase)
        │                                        │                    └▶ Storage (service key)
        ├──WSS, 5-min room ticket─────────▶ apps/server sync (ws)  ──▶ Redis (Render Key Value)
        └──Supabase Auth only (sign-in, refresh)
Razorpay ──HTTPS, HMAC-signed webhook──▶ /billing/webhooks/razorpay
Render Cron ──HTTPS, CRON_SECRET──▶ /internal/*
apps/server ──HTTPS──▶ Anthropic (SDK), Razorpay API, Supabase Storage, Resend
```

- **Everything from a browser is untrusted:** request bodies, query strings, headers, WebSocket
  frames (Yjs updates, presence), and anything a user typed that later reaches the AI prompt.
- **Identity** comes only from a verified Supabase JWT (`apps/server/src/auth/verifier.ts`:
  JWKS, issuer, audience `authenticated`, `ES256/RS256/EdDSA`, 5 s clock tolerance; anonymous
  Supabase sessions refused). A user id in a body is never trusted.
- **The public Supabase API (PostgREST)** can't read our tables: RLS is on for every `public`
  table with no policies for `anon`/`authenticated` (`packages/shared/test/rls.test.ts`
  fails otherwise). The browser uses Supabase for sign-in only.
- **Secrets** (`SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `ROOM_TICKET_SECRET`,
  `CRON_SECRET`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`,
  `RESEND_API_KEY`, `METRICS_TOKEN`) exist only in apps/server's env on Render. The web build
  can only read `VITE_*` values, all public by design (`packages/shared/src/env/web.ts`).

## OWASP Top 10 (2021) walkthrough

### A01 Broken access control

- **One permission table** decides every board action: `can(role, action)` in
  `apps/server/src/access/boardAccess.ts` (viewer < editor < owner). REST routes call
  `authorize(deps, boardId, userId, action, { shareToken })` (`apps/server/src/api/boards.ts`);
  it resolves membership, org membership, share link, public flag, the plan lock
  (`BOARD_LOCKED`) and editor seats in one query.
- **WebSockets:** the upgrade needs a 5-minute HMAC room ticket from `POST /boards/:id/ticket`
  (`auth/tickets.ts`), **re-checked against the database on every upgrade**
  (`sync/ticketAuth.ts`). Viewers' writes are dropped server-side (`sync/connection.ts`,
  `write_denied` metric). Revoking a member, link or public access, or deleting a board,
  closes live sockets on every instance (`revocation/bus.ts`, Redis pub/sub).
- **Presence can't impersonate** (added in 12a): a signed-in socket may only publish its own
  user id, an anonymous one only a `guest-` id; a client id belongs to the first connection
  that claims it (`SyncConnection.mayPresentAs` / `mayClaim`). Private rooms relay encrypted
  presence the server can't read (see Limitations of private boards).
- **Plan limits** are enforced on the server (entitlements table, `billing/limits.ts`), never
  only in the UI; a forged "editor" ticket over the seat limit is capped to viewer.
- **Internal endpoints** need `CRON_SECRET` (compared in constant time since 12a,
  `http/bearer.ts`); `/metrics` needs `METRICS_TOKEN` (required in production).
- **Open redirects:** the only redirect is "back to where you were" after sign-in, stored in
  `sessionStorage` and accepted only as a same-origin path (`isSafeReturnPath`,
  `apps/web/src/auth/localData.ts`; `/\evil.test` refused since 12a).
- Tests: `authz.pg.test.ts` (actor × read/write/share/delete matrix over REST and WebSocket, tampered tickets, revocation), `limits.pg.test.ts`,
  `sync.integration.test.ts` (presence spoofing and impersonation),
  `cluster.redis.test.ts` (across instances), `lib/__tests__/privacy.test.ts` (return path).

### A02 Cryptographic failures

- TLS everywhere: Vercel and Render terminate HTTPS; HSTS on the web (`vercel.json`) and API
  (`http/securityHeaders.ts`); the web CSP adds `upgrade-insecure-requests` on https builds.
- Share-link and invite tokens: 32 random bytes, stored only as SHA-256 hashes
  (`api/tokens.ts`); the raw token is returned once. Student-trial emails are stored hashed.
- Room tickets: HS256 with a ≥ 32-character secret, 5-minute expiry.
- Webhooks: HMAC-SHA256 over the exact raw body, constant-time compare (`billing/razorpay.ts`).
- Private boards: AES-GCM-256 in the browser; the key never reaches our servers (below).
- Passwords: none. Supabase Auth does magic links and OAuth only.

### A03 Injection

- **SQL:** Drizzle query builder and `sql` template tags only (parameterised). There is no
  `sql.raw` or string-built SQL in `apps/server/src` or `packages/shared/src`.
- **XSS:** React escapes everything; no `dangerouslySetInnerHTML` in `apps/web/src`.
  Prerendered HTML escapes titles/descriptions (`site/seo.ts` `escapeHtml`) and JSON-LD /
  public data (`<` escaped). Emails are React Email components (escaped). The CSP (below)
  blocks inline and third-party scripts even if an escape were missed.
- **Prompt injection:** board text goes to Claude inside an `<untrusted_board_data>` block
  with explicit instructions to ignore instructions in it (`ai/prompts.ts`); the output must
  match a zod schema and may only reference shape ids that exist in the graph
  (`ai/repair.ts`); the model has no tools and can't act. The eval set includes injection
  boards.
- **Log injection:** pino writes JSON (values escaped).

### A04 Insecure design

- Limits are designed in, not bolted on: plan limits, AI spend kill-switch
  (`AI_DAILY_SPEND_LIMIT_USD`, `AI_ENABLED`), per-user AI quotas, per-connection message and
  byte budgets, rate limits (table below).
- Payment state is never taken from the browser or the webhook body: the server re-fetches the
  subscription from Razorpay (`billing/sync.ts`) and applies it idempotently.
- Deletions are soft first (30-day trash) and audited; permission, money and deletion changes
  write `audit_logs` rows.

### A05 Security misconfiguration

- Env vars validated at boot with zod (`packages/shared/src/env/server.ts`); production refuses
  to start without `REDIS_URL`, `METRICS_TOKEN`, `CRON_SECRET`, the Storage service key,
  `ANTHROPIC_API_KEY` and every Razorpay setting, with a `rzp_test_` key, or with any email
  transport other than Resend (the dev "log" transport prints invite links).
- CORS: explicit origin allowlist plus an anchored pattern for this project's Vercel
  previews; `credentials: false`; WebSocket upgrades check `Origin` too (`http/origins.ts`).
- Security headers on the web and the API (section below); the web CSP is built per
  environment. No default credentials; no debug endpoints in production builds
  (`VITE_DEBUG_TOOLS` is E2E-only).
- Error responses are typed and user-safe (`errors.ts`); stack traces only in logs.

### A06 Vulnerable and outdated components

- `pnpm audit --prod --audit-level=high` runs in CI (`security` job) and fails the build on a
  high/critical advisory in anything that ships. See "Dependencies" below for the current
  dev-only advisories and why they are accepted.
- Exact versions pinned (`pnpm-lock.yaml`, catalog in `pnpm-workspace.yaml`); install
  scripts are blocked except `esbuild`.

### A07 Identification and authentication failures

- Supabase Auth (magic link, Google, GitHub). Access tokens are short-lived JWTs verified
  against JWKS on every request and every ticket; set the JWT expiry to 15 minutes in each
  Supabase project (sign-out-everywhere doesn't revoke an issued token before it expires).
- Rate limits on sign-in adjacent routes (`/me/bootstrap` 10/min) and on token guessing
  (share-link resolve 30/min, invite accept 30/min). Tokens are 256-bit, so guessing is
  impractical anyway.
- Sessions live in `localStorage` (Supabase default), never in cookies, which is what makes
  the API immune to classic CSRF (A01/CSRF below).

### A08 Software and data integrity failures

- Webhooks: signature verified before parsing; duplicates ignored via
  `UNIQUE(provider, provider_event_id)`.
- CI runs lint, typecheck, tests, build, dependency audit, secret scan (gitleaks + our
  scanner) on every push. Deploys are manual (`autoDeploy: false`).
- Web code delivery: the CSP allows scripts from our origin only (plus Razorpay Checkout);
  SRI/published build hashes for private-board code delivery are a Later item.
- Yjs updates from clients are applied by `y-protocols` with size and rate limits; a bad
  snapshot is recoverable from the update archive.

### A09 Security logging and monitoring failures

- pino JSON logs with a request id on every request; authorization, cookie and
  `x-share-token` headers are redacted (`logger.ts`; test in `security.test.ts`).
- `audit_logs` rows for board creation/deletion/restore/purge, sharing and membership
  changes, invites, interviews, billing (checkout, sync, cancel, plan change, downgrade),
  team membership and seat releases.
- Prometheus metrics (`/metrics`): rejected upgrades by reason (`origin`, `unauthorized`,
  `rate_limited`, `too_many_sockets`), dropped writes, `awareness_spoofed`,
  `awareness_impersonation`, `awareness_invalid`.
- Sentry, uptime monitors and alerting: Phase 12b (see docs/runbook.md once written).

### A10 Server-side request forgery

- The server never fetches a URL supplied by a user: no link previews, image imports or
  customer webhooks. Outbound calls go to Supabase Storage, Razorpay and Anthropic (SDK,
  fixed base URL) only.
- Since 12a every outbound `fetch` goes through `createSafeFetch` (`http/safeFetch.ts`): an
  allowlist of exact origins (our Supabase project; `https://api.razorpay.com`),
  userinfo in the URL refused, redirects refused, 15 s default timeout. Path tricks
  (`..`, encoded `//`) can't change the host. Test: `safeFetch.test.ts` (metadata IP,
  localhost, look-alike hosts, scheme downgrade).
- Razorpay ids are validated before they are put in a URL path.

## CSRF

The API authenticates with `Authorization: Bearer` only. No cookie is ever set or read, and
CORS never allows credentials, so a cross-site form or `fetch` carries no credentials and
can't act as the user. As defence in depth (12a), the API parses only JSON (and PNG for
thumbnails): `text/plain`, url-encoded and multipart bodies — the ones a cross-site page can
send without a CORS preflight — get **415** before any route code runs.
`security.test.ts` checks this for **every** mutating route in the route table, so a new
route can't miss it. The webhook (signature) and cron routes (secret) don't use sessions.
WebSockets: `Origin` must be allowlisted (cross-site WebSocket hijacking) and a ticket is
required.

## Browser and HTTP protections

**Web app (Vercel).** `apps/web/vercel.json` sends, for every path: HSTS
(`max-age=31536000; includeSubDomains`, no `preload` until the domain is final),
`Content-Security-Policy: frame-ancestors 'none'; object-src 'none'; base-uri 'self'`,
`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, a `Permissions-Policy` that turns off
camera, microphone, geolocation, USB, serial and Bluetooth and allows the Payment Request API
only for our origin and Razorpay, and `Cross-Origin-Opener-Policy: same-origin-allow-popups`
(Razorpay may open bank/UPI popups that talk back to the page).

**Content Security Policy.** Built at build time from the deployment's `VITE_*` URLs
(`apps/web/scripts/csp.ts`) and placed as a `<meta>` tag at the top of every HTML file
(app shell and prerendered pages), because the API/Supabase/PostHog hosts differ per
environment. Directives a meta tag can't carry (`frame-ancestors`) come from the header above;
browsers enforce both. Production policy:

| Directive                                 | Sources                                                                                                                                 | Why                                                                                               |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `script-src`                              | `'self'`, sha256 of the dark-mode `<head>` script, `https://checkout.razorpay.com`, `'wasm-unsafe-eval'`                                | no inline scripts, no `eval`; WebAssembly for the PDF export's layout engine                      |
| `style-src`                               | `'self' 'unsafe-inline'`                                                                                                                | React `style` attributes in prerendered HTML and Radix popover positioning; styles can't run code |
| `connect-src`                             | `'self'`, API origin, WebSocket origin, Supabase project, `api.razorpay.com`, `lumberjack.razorpay.com`, PostHog host (only with a key) | exactly this environment's hosts                                                                  |
| `img-src`                                 | `'self' data: blob:`, Supabase project                                                                                                  | exports, canvas snapshots, signed thumbnail URLs                                                  |
| `frame-src`                               | `api.razorpay.com`, `checkout.razorpay.com`                                                                                             | Razorpay Checkout                                                                                 |
| `worker-src`                              | `'self' blob:`                                                                                                                          | service worker                                                                                    |
| `object-src` / `base-uri` / `form-action` | `'none'` / `'self'` / `'self'`                                                                                                          |                                                                                                   |
| `upgrade-insecure-requests`               | on https builds                                                                                                                         |                                                                                                   |

zod runs in jitless mode in the browser (`src/lib/zodConfig.ts`) so it never probes
`new Function`. PostHog runs with `disable_external_dependency_loading` (no scripts from its
CDN). **Every Playwright test fails on any CSP violation** (`apps/web/e2e/fixtures.ts`), so
the whole E2E suite (sign-in, boards, sync, sharing, private boards, reviews, interviews,
billing) runs under the real policy. Unit test: `scripts/csp.test.ts`.

**URL fragments never leave the browser.** Private-board keys (`#key=…`) and interview summary
tokens live in fragments. PostHog records full URLs (`$current_url`, `$referrer`, initial
URLs), so until 12a a private board's key would have been sent to PostHog for visitors who
accepted analytics. Fixed: PostHog's `before_send` strips fragments from every URL in every
event (`lib/privacy.ts`, test `lib/__tests__/privacy.test.ts`). Sentry (12b) must use the same
scrubber.

**API (Render).** Every response (including 404s, errors and the review event stream) carries
`Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'`,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
`Cross-Origin-Opener-Policy: same-origin`, HSTS, and `Cache-Control: no-store` unless a route
sets its own (`apps/server/src/http/securityHeaders.ts`, `app.ts`).

## Rate limits

REST limits use `@fastify/rate-limit` with the Redis store (shared by all instances; fail-open
on a Redis error so an outage doesn't lock everyone out). Keys are the user id when signed in,
otherwise the client IP (`TRUST_PROXY=1` on Render so the IP is the one Render's load balancer
saw, not a forged `X-Forwarded-For`).

| Scope                                                  | Limit                                                                           | Key        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- | ---------- |
| Every API route (default)                              | 300 / min                                                                       | user or IP |
| `POST /me/bootstrap`                                   | 10 / min                                                                        | user       |
| `POST /boards/:id/ticket`                              | 60 / min                                                                        | user or IP |
| `POST /boards/:id/invites`                             | 20 / hour                                                                       | user       |
| `POST /share-links/resolve`, `POST /invites/accept`    | 30 / min                                                                        | user       |
| `POST /boards/:id/reviews` (AI)                        | 10 / min (+ monthly quota, daily spend cap)                                     | user       |
| `POST /boards/:id/hints` (AI)                          | 30 / min (+ hourly cap)                                                         | user       |
| `POST /interviews/:id/share-links`                     | 20 / hour                                                                       | user       |
| `POST /billing/checkout` / `refresh` / `student-trial` | 10 / 20 / 5 per min                                                             | user       |
| `/internal/*` (cron)                                   | 30 / min                                                                        | IP         |
| `/billing/webhooks/razorpay`                           | 600 / min                                                                       | IP         |
| WebSocket upgrades                                     | `SYNC_UPGRADES_PER_MIN_PER_IP` (120) / min, checked before any token or DB work | IP (Redis) |
| Open sockets                                           | `SYNC_MAX_CONNECTIONS_PER_USER` (20) per instance                               | user       |
| Messages on a socket                                   | 120/s, burst 300; 1 MiB/s, burst 16 MiB (token buckets)                         | connection |
| `/healthz`, `/readyz`, `/metrics`                      | none; `/readyz` coalesces concurrent probes into one run of its checks          | —          |

`security.test.ts` asserts that **every** API route in the route table answers 429 once a
client's budget is used (shared or route-specific), plus the cron and webhook limits;
`upgradeLimits.test.ts` and `windowLimiter.redis.test.ts` cover sockets.

## Input size limits

- HTTP bodies: 256 kB by default (`DEFAULT_BODY_LIMIT`, 413 before route code); 1 MB for
  `POST /boards/:id/reviews` (a private board's graph); 300 kB PNG for thumbnails; 256 kB for
  the webhook.
- Every request schema bounds its strings and arrays (titles 120, notes 5,000, scorecard
  comments 2,000, invite email 254, tokens 16–128, participants 20…). A private board's graph
  sent for review is bounded too since 12a: ≤ 5,000 nodes and edges, labels ≤ 500 characters,
  instance counts ≤ 1,000 (`GRAPH_INPUT_LIMITS`, `packages/graph/src/review.ts`); the server
  also refuses graphs above `AI_REVIEW_MAX_ELEMENTS` (600).
- WebSocket frames: `MAX_CLIENT_MESSAGE_BYTES` (`maxPayload`), awareness updates ≤ 1,000
  entries and schema-checked; per-connection byte budget.

## Dependencies

`pnpm audit --prod` (what ships): **no known vulnerabilities** (2026-09-28). Fixed in 12a:
`fflate` (satori, build-time Open Graph images) pinned to `^0.7.5` via `overrides` in
`pnpm-workspace.yaml`. Remaining advisories are in development tools only and never run on
a server or in a browser:

| Package                          | Via                            | Advisory                                        | Why accepted                                                                                                                    |
| -------------------------------- | ------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `esbuild` ≤ 0.24.2               | `drizzle-kit` → `@esbuild-kit` | dev server answers cross-origin requests        | we never run esbuild's dev server; drizzle-kit uses it as a loader                                                              |
| `esbuild` 0.27                   | `loadtest`                     | Windows-only file read via dev server           | load-test bundling only, no dev server, not Windows                                                                             |
| `extract-zip` ≤ 2.0.1 (×2, high) | `lighthouse` → `puppeteer`     | symlink path traversal when extracting archives | only extracts Chrome downloads from Google's servers during `pnpm --filter @whiteboard/web lighthouse`; no fixed version exists |
| `@opentelemetry/core` < 2.8      | `lighthouse` → `@sentry/node`  | unbounded baggage allocation                    | inside the local Lighthouse CLI only                                                                                            |

Re-check on every dependency update: `pnpm security:audit` (fails on high in prod deps) and
`pnpm audit` (everything).

## Secrets

- `.env` files are git-ignored; only `.env.example` files have ever been committed.
- **History scan (2026-09-28):** `node scripts/secret-scan.mjs` over every commit on every ref
  plus the index found **no credentials**. Its hits were all test fixtures, which in this repo
  always contain `0123456789` (allowlisted by that marker, not by file, so a real key pasted
  into a test is still caught), and the docker-compose default `postgres:postgres`.
- CI runs the same script plus gitleaks v8 with default rules (`.gitleaks.toml`, same
  allowlist) on the full history.
- If a secret leaks: rotate it first (docs/runbook.md, 12e), then remove it from history.
- Secrets never go to the browser (the web env schema only accepts `VITE_*` public values),
  into logs (redaction) or into error messages (typed errors with fixed user messages).

## Audit findings (Phase 12a)

| #   | Finding                                                                                                 | Severity                        | Status                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | Private-board keys in URL fragments sent to PostHog in `$current_url`/`$referrer`                       | High (breaks the E2E promise)   | Fixed: `before_send` scrubber                                                            |
| 2   | No CSP or security headers on the web app                                                               | Medium                          | Fixed: per-environment CSP + headers                                                     |
| 3   | Presence could show another user's id/name (cursor, follow target, avatar list)                         | Medium                          | Fixed: server enforces own id / `guest-`                                                 |
| 4   | WebSocket upgrades unlimited per IP/user (token verification + DB query each)                           | Medium                          | Fixed: per-IP window (Redis) + per-user cap                                              |
| 5   | Cron and webhook routes had no rate limit                                                               | Low                             | Fixed: 30 / 600 per min per IP                                                           |
| 6   | Cron secret compared with `!==` (timing)                                                                | Low                             | Fixed: constant-time                                                                     |
| 7   | 1 MB default body limit; private review graph unbounded (labels, counts)                                | Low                             | Fixed: 256 kB default, bounded graph schema                                              |
| 8   | `text/plain` bodies parsed on API routes (preflight-free cross-site writes, if cookies were ever added) | Low (no cookies today)          | Fixed: 415                                                                               |
| 9   | `/readyz` ran DB + Redis checks per request, unauthenticated                                            | Low                             | Fixed: concurrent probes coalesced                                                       |
| 10  | Outbound fetch had no host allowlist/redirect policy                                                    | Low (no user URLs today)        | Fixed: `createSafeFetch`                                                                 |
| 11  | Return path accepted `/\host` (backslash)                                                               | Low                             | Fixed                                                                                    |
| 12  | `x-share-token` not in log redaction                                                                    | Low                             | Fixed                                                                                    |
| 13  | Web build publishes source maps (`build.sourcemap: true`)                                               | Low (source is readable anyway) | Phase 12b: hidden maps uploaded to Sentry, deleted from `dist`                           |
| 14  | Display names in presence are chosen by the client                                                      | Low                             | Open: names still come from the client; ids are enforced. Could be moved into the ticket |
| 15  | Encrypted-room presence can't be checked by the server                                                  | Accepted                        | By design (ciphertext)                                                                   |

## Private boards: end-to-end encryption

Private boards (Pro and Team) are end-to-end encrypted: board content is encrypted in the
browser, and our servers (API, sync server, Redis, Postgres, Storage) only ever hold
ciphertext. This document covers the threat model, what the server can and cannot see, how the
design works, and its limitations.

Code: `packages/shared/src/sync/e2e.ts` (crypto), `encryptedProtocol.ts` and
`encryptedProvider.ts` (client protocol), `apps/server/src/sync/encryptedRoom.ts` and
`encryptedConnection.ts` (relay and storage), `apps/web/src/features/board/e2e/` (UI, key
handling). Tests: `apps/server/test/private*.test.ts`, `packages/shared/test/sync/e2e.test.ts`,
`apps/web/src/features/board/__tests__/privateBoards.test.tsx`, `apps/web/e2e/private.spec.ts`.

### Threat model

**Protected against:** anyone who can read what our servers hold or relay, including us:

- a database leak or backup theft (Supabase), a Redis dump, server logs;
- an attacker with read access to a running sync server or API instance;
- our own staff, a subpoena for stored data, or a compromised hosting account;
- the public Supabase API: private boards' rows are protected by RLS like every table _and_
  are ciphertext.

**Not protected against:**

- **An actively malicious server**, which can serve modified JavaScript that reads the key.
  This is the fundamental limit of web-based end-to-end encryption (the same code delivery
  trust applies to every browser-based E2E product). Mitigations for later: Subresource
  Integrity, a published build hash, a browser extension that verifies builds.
- **A compromised device or browser** (malware, a malicious extension): the key and the
  decrypted board are in the page.
- **People who have the link.** The link is the key. Anyone it is shared with (or who sees it
  in a screen share, chat log or browser history) can decrypt the board if they also have
  access on the server (see "Two locks" below).
- **Editors acting in bad faith**: someone who holds the key and edit access can delete
  content or upload a bad snapshot, like on any shared board (see Limitations).

### Two locks

Opening a private board needs **both**:

1. **Server access**, exactly as for normal boards: membership, invite or share link, checked on
   every REST request and every WebSocket (ticket + database re-check). Revoking access kicks
   live sessions.
2. **The key**, which only exists in browsers. The server can't give it out, and invite
   emails never contain it.

Revoking server access immediately stops someone from getting further updates. Changing the key
(re-encrypting the board) isn't supported yet (see Limitations).

### Keys

- 32 random bytes from `crypto.getRandomValues`, generated in the browser when the board is
  created, used as an AES-GCM-256 key (WebCrypto, imported as non-extractable).
- Carried in the URL **fragment**: `/board/<id>#key=<base64url>`. Browsers never send the
  fragment to servers: not in requests, not in the `Referer` header. The E2E test checks every
  request URL, request body, WebSocket frame and response of both browsers for the key and the
  board's labels.
- **Key check:** at creation, the browser stores a known plaintext encrypted with the key on the
  board row. Before using a key (from a link, a paste or the device), the browser verifies it,
  so a wrong key never writes anything to the board.
- **On the device:** keys of private boards you open are remembered in IndexedDB
  (`whiteboard:keys`) so the dashboard can show their titles and reopen them without the link.
  They are deleted on sign-out; the dashboard warns first, because the links are then the only
  way back in.
- **Share links and invites:** "Copy link with key" and new share links append `#key=…`; the
  `/s/:token` landing page passes the fragment on to the board. Invite emails can't include
  the key (the server would see it): the dialog tells the owner to send the link themselves.
  A person without the key sees a "paste the link" screen.

### Encryption format

Every encrypted value is an envelope:
`version (1 byte) ‖ IV (12 random bytes) ‖ AES-GCM ciphertext ‖ tag (16 bytes)`.

The additional authenticated data is `wb:e2e:v1:<kind>:<boardId>`, with kind one of `update`,
`snapshot`, `awareness`, `title`, `keycheck`. So the server can't:

- move ciphertext from one board to another,
- make a presence message pass for a document update, or an update for a snapshot,
- modify anything without detection (GCM authentication).

### What the server can and cannot see

| The server **cannot** see                                          | The server **can** see (metadata)                                       |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Shapes, labels, connections, positions, styles, drawings           | That the board exists, that it is private, its id, owner, workspace     |
| The board's title (stored encrypted; the row says "Private board") | Who has access, invites, share links, the audit log                     |
| Cursors, selections, viewports and display names in presence       | Who is connected when, from which IP, and for how long                  |
| Snapshots of the board                                             | Number, sizes and timing of updates (a busy editing session is visible) |
| The key                                                            | Approximate board size (ciphertext length)                              |
| AI review content — unless the user consents for that review       | That an AI review ran, its token usage and cost (`ai_usage`)            |

### How it works

#### Sync

Private boards use a separate wire protocol (`MESSAGE_ENC_*`). The sync server refuses plain
Yjs messages in a private room (and encrypted messages in a normal room) with close code 1007. It never parses envelopes; it checks only their shape (version byte, minimum length),
the sender's role (viewers' updates and snapshots are dropped), and that each connection's
update counter increases.

- **Joining:** the server sends the stored board as `ENC_STATE` (latest encrypted snapshot +
  every encrypted update after it). The client decrypts and applies it, then sends exactly what
  the server lacks (offline edits, deletions included), computed against a copy of what the
  server sent.
- **Editing:** local updates are merged per animation frame, encrypted and sent with a
  per-connection counter. The server relays them to the room (and other instances over Redis)
  and persists them like any update (write-ahead, batched).
- **"Saved":** the server acknowledges with a `peer → counter` vector (the same message as a
  Yjs state vector for normal boards). A client is "Saved" when its last sent counter is
  committed.
- **Presence:** encrypted like updates; the server relays the last envelope per connection
  (peer id) and tells everyone when a connection leaves. Clients validate decrypted presence
  (zod) and bind each presence id to the peer that first sent it, so one key holder can't move
  or remove another's cursor.
- **Order:** clients process messages strictly in order (decryption is asynchronous); this is
  what makes snapshot requests safe (below).

#### Snapshots (compaction)

The server can't merge ciphertext, so clients compact for it. After `SNAPSHOT_EVERY_UPDATES`
stored updates, the room's persistence writer:

1. takes the last committed seq `S`;
2. checks, from the database, that every stored update up to `S` is in its in-memory log
   (adding and relaying any it never saw, e.g. written by a previous writer);
3. asks one synced **editor** connected to it for a snapshot covering `S`. The client has, in
   message order, already applied everything up to `S`, so it encrypts its full document
   state and sends it back;
4. stores the snapshot and archives the updates up to `S` in one transaction
   (`installSnapshot`, which refuses non-private boards, a `seqUpto` beyond the last stored
   update, or one not newer than the latest snapshot).

Only a reply from the connection that was asked, for the request it was asked, within 30 s,
is accepted. If no editor is connected to the writer, compaction simply waits; updates stay
safely in `board_updates`. The server's own compaction (`compact`) refuses private boards.

#### Features that need to read the board

These are refused server-side for private boards (409 `PRIVATE_BOARD`) and explained in the
UI:

- **Thumbnails** — a thumbnail would show the content. The dashboard shows a lock instead.
- **Search** — titles are encrypted; private boards are excluded from search, and the
  dashboard says so. Titles are decrypted locally for display.
- **Server-side copies and exports** — duplicate is refused; the future "export all my
  boards" must export private boards as ciphertext or skip them. PNG/SVG export runs in the
  browser and keeps working.
- **Public read-only links** — anyone would need the key anyway.
- **Live AI hints** — they would send the board on every change.
- **Interviews** — replay and the summary are built on the server from the board's history.

#### AI review

The browser extracts the design graph (component kinds, labels, connections, group
membership — not positions, styles, freehand drawings or free text shapes) and sends only
that, and only after the user ticks "I agree to send this board's graph for this review" in
the review dialog (every time; never pre-ticked or remembered). The server validates the graph
with the shared zod schema, runs the rules engine on it itself, and sends it to Anthropic like
any review.

**Nothing is kept unless the user opts in** ("Keep this review on the server"): the quota
reservation row has no content and is deleted when the review ends; only the `ai_usage` row
(tokens, cost, status — no content) remains, so the monthly allowance still counts it. The
review is streamed to the requester's browser and shown for that session. Opted-in reviews are
stored like normal ones (and are then readable by the server, which the dialog says).

For normal boards the server still reads the graph from the database and refuses a graph in
the request.

### Limitations

- **Web code delivery** (see threat model): users trust the JavaScript we serve.
- **Losing the link = losing the board**, unless a device still remembers the key. We can't
  recover it. Shown at creation (the owner must confirm they saved the link), in the Share
  dialog, and before sign-out.
- **No key rotation or revocation of the key.** Removing someone's access stops them syncing,
  but they may still hold the key and any copy of the board they already had (in their browser
  or IndexedDB). Rotating means creating a new private board (a re-encrypting "rotate key"
  flow is future work).
- **Converting a board** to private (or back) isn't supported; privacy is chosen at creation.
- **Metadata** is visible: who, when, how often, how much (no padding or cover traffic).
- **The server can withhold or roll back**: it can drop updates, not deliver some, or serve an
  older snapshot. It can't forge or alter content (authenticated encryption), and Yjs ignores
  replays.
- **Editors are trusted with the content.** An editor with the key could upload a snapshot
  that loses content. Old updates are archived and snapshots are never deleted, so a board
  can be restored by support from history, but not by the server reading it.
- **Undecryptable messages** (corrupt, or written with another key) are skipped and counted by
  the client rather than locking everyone out; a snapshot that can't be decrypted, or a board
  where nothing decrypts, stops the client with "This board can't be decrypted".
- **Local copies are plaintext**: the offline IndexedDB copy of a board (like for normal
  boards) and the remembered keys live on the device. They are deleted on sign-out; closing
  the tab on a shared computer leaves them.
- **Nonce limits**: AES-GCM with random 96-bit IVs is safe up to about 2³² messages per key;
  at 60 messages a second non-stop that is over two years of editing.
- **Non-writer instances** keep a private room's full in-memory log (not trimmed by client
  snapshots) until the room is evicted; newcomers served by such an instance get a larger
  initial state. Correct, just bigger.
- **Plan changes:** private boards stay usable after a downgrade; creating new ones needs Pro
  or Team.
