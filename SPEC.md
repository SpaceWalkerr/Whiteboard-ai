# Whiteboard.ai — Product Spec

## One-liner
A real-time collaborative whiteboard for system design, where an AI reviews your architecture
diagram like a senior engineer — for interview practice, interviews, and team design reviews.

## Who pays
1. Individuals preparing for system-design interviews (students, SDE-1/2) — Pro plan.
2. Interviewers / hiring teams running live design rounds — Team plan.
3. Engineering teams doing design reviews — Team plan.

## Plans (enforced server-side via an entitlements table, never only in the UI)
| | Free | Pro (₹399/mo · $8/mo) | Team (₹999 · $15 per seat/mo) |
|---|---|---|---|
| Boards | 3 | Unlimited | Unlimited |
| Editors per board | 3 | 10 | 50 |
| AI design reviews / month | 5 | 100 | 300 per seat, pooled |
| Live AI hints | – | ✓ | ✓ |
| Private end-to-end encrypted rooms | – | ✓ | ✓ |
| Session replay + PDF export | view only | ✓ | ✓ |
| Interview mode (roles, timer, scorecard) | – | – | ✓ |
| Org workspace, member management, audit log | – | – | ✓ |
Annual billing = 2 months free. Students: Pro free for 3 months with a .edu / .ac.in email.

## Core features
1. **Canvas**: infinite pan/zoom; rectangle, ellipse, text, sticky note, freehand, arrows that
   bind to shapes and follow them; select, multi-select, move, resize, rotate, group, align,
   duplicate, delete, copy/paste, undo/redo (per-user), keyboard shortcuts, snapping.
2. **System-design shape library** (typed shapes): Client, CDN, Load Balancer, API Gateway,
   Service, Database (SQL/NoSQL, primary/replica), Cache, Queue/Stream, Object Storage,
   Search Index, Worker, External API. Arrows carry a label + type (sync call / async / replication).
3. **Real-time collaboration**: live cursors with names/colours, presence avatars, follow mode,
   selection highlights, offline editing that merges on reconnect.
4. **Boards & sharing**: dashboard, folders, templates, share links with role (viewer/editor),
   email invites, public read-only links, duplicate board, thumbnails.
5. **AI design review**: the canvas is converted into a typed graph; a deterministic rules engine
   finds obvious problems; Claude produces a structured review (findings with severity, the shape
   IDs they refer to, and a suggested fix), shown as highlights on the canvas. Live hints while
   drawing (Pro+). Every finding links to the shapes it is about.
6. **Interview mode** (Team): interviewer/candidate roles, question bank, countdown timer,
   private interviewer notes, rubric scorecard, full session replay with a timeline scrubber.
7. **Private rooms** (Pro+): end-to-end encrypted. The AES-GCM key lives in the URL fragment;
   the server stores and relays ciphertext only. AI review in a private room requires explicit
   per-review consent and sends only the extracted graph.
8. **Billing**: Razorpay subscriptions (INR, India) first, behind a `BillingProvider` interface so
   a Merchant of Record (Lemon Squeezy / Paddle) can be added for international customers.
9. **Account**: profile, delete account (hard delete after 30 days), export all my boards (JSON).

## Non-functional targets
- Edit → visible on another client: p95 < 150 ms within one region.
- 50 concurrent editors in one board; 2,000 concurrent connections per sync instance.
- Board loads in < 1.5 s for a 2,000-shape board. Lighthouse ≥ 90 on marketing pages.
- Zero data loss on sync-server restart (updates persisted before ack; graceful shutdown flushes).
- Daily database backups + point-in-time recovery (Supabase Pro + PITR). Uptime target 99.5%.
- Primary region: Singapore — Render `singapore` (server + Key Value) and Supabase
  `ap-southeast-1`, co-located. Frontend served from Vercel's edge network.

## Hosting (decided)
| Part | Platform |
|---|---|
| Frontend — React + Vite SPA | Vercel |
| Backend — Node (REST API + WebSocket sync, one service, 2+ instances) | Render |
| Database, Auth, file Storage | Supabase |
| Redis (pub/sub between instances, rate limits, leases) | Render Key Value |
| Email | Resend |

## Rough monthly running cost at launch (verify current prices)
Render web service ×2 (paid instances, needed so WebSockets never sleep) + Render Key Value +
Supabase Pro (~$25) + Vercel Pro (~$20; the Hobby plan is for non-commercial use only) +
Resend free tier + Claude API usage (capped by quotas).
Budget roughly $70/month before AI usage; break-even is ~15 Pro subscribers.
During development (before charging anyone) the free tiers are fine.

## Out of scope for v1
Mobile apps, video/voice calls, SSO/SAML, self-hosting, plugins/API.
