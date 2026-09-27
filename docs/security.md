# Private boards: end-to-end encryption

Private boards (Pro and Team) are end-to-end encrypted: board content is encrypted in the
browser, and our servers (API, sync server, Redis, Postgres, Storage) only ever hold
ciphertext. This document covers the threat model, what the server can and cannot see, how the
design works, and its limitations.

Code: `packages/shared/src/sync/e2e.ts` (crypto), `encryptedProtocol.ts` and
`encryptedProvider.ts` (client protocol), `apps/server/src/sync/encryptedRoom.ts` and
`encryptedConnection.ts` (relay and storage), `apps/web/src/features/board/e2e/` (UI, key
handling). Tests: `apps/server/test/private*.test.ts`, `packages/shared/test/sync/e2e.test.ts`,
`apps/web/src/features/board/__tests__/privateBoards.test.tsx`, `apps/web/e2e/private.spec.ts`.

## Threat model

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

## Two locks

Opening a private board needs **both**:

1. **Server access**, exactly as for normal boards: membership, invite or share link, checked on
   every REST request and every WebSocket (ticket + database re-check). Revoking access kicks
   live sessions.
2. **The key**, which only exists in browsers. The server can't give it out, and invite
   emails never contain it.

Revoking server access immediately stops someone from getting further updates. Changing the key
(re-encrypting the board) isn't supported yet (see Limitations).

## Keys

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

## Encryption format

Every encrypted value is an envelope:
`version (1 byte) ‖ IV (12 random bytes) ‖ AES-GCM ciphertext ‖ tag (16 bytes)`.

The additional authenticated data is `wb:e2e:v1:<kind>:<boardId>`, with kind one of `update`,
`snapshot`, `awareness`, `title`, `keycheck`. So the server can't:

- move ciphertext from one board to another,
- make a presence message pass for a document update, or an update for a snapshot,
- modify anything without detection (GCM authentication).

## What the server can and cannot see

| The server **cannot** see                                          | The server **can** see (metadata)                                       |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Shapes, labels, connections, positions, styles, drawings           | That the board exists, that it is private, its id, owner, workspace     |
| The board's title (stored encrypted; the row says "Private board") | Who has access, invites, share links, the audit log                     |
| Cursors, selections, viewports and display names in presence       | Who is connected when, from which IP, and for how long                  |
| Snapshots of the board                                             | Number, sizes and timing of updates (a busy editing session is visible) |
| The key                                                            | Approximate board size (ciphertext length)                              |
| AI review content — unless the user consents for that review       | That an AI review ran, its token usage and cost (`ai_usage`)            |

## How it works

### Sync

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

### Snapshots (compaction)

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

### Features that need to read the board

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

### AI review

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

## Limitations

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
