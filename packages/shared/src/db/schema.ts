import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { authUsers } from "drizzle-orm/supabase";
import { INTERVIEW_ROLES, INTERVIEW_STATUSES } from "../interview";
import { BILLING_INTERVALS, BILLING_PROVIDERS } from "../billing";
import { ENTITLEMENT_SOURCES, SUBSCRIPTION_STATUSES } from "../entitlements/derive";
import { PLANS } from "../entitlements/limits";

/**
 * One row per Supabase Auth user. The id IS the auth user id, so deleting the auth user
 * cascades here. RLS is enabled with no policies: only apps/server (which connects as the
 * table owner) can read or write it, never the public PostgREST API.
 */
export const profiles = pgTable("profiles", {
  id: uuid("id")
    .primaryKey()
    .references(() => authUsers.id, { onDelete: "cascade" }),
  email: text("email"),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => sql`now()`),
}).enableRLS();

export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;

/** Binary column (Yjs updates and snapshots). postgres.js maps bytea to Buffer. */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (value) => Buffer.from(value.buffer, value.byteOffset, value.byteLength),
  fromDriver: (value) => new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
});

/**
 * A board. The row is created together with its first persisted update, so merely opening a
 * random board URL stores nothing. `owner_id` is set from Phase 4 (sign-in).
 */
export const boards = pgTable(
  "boards",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").references(() => authUsers.id, { onDelete: "set null" }),
    title: text("title").notNull().default("Untitled board"),
    /** Workspace the board belongs to (null only for pre-Phase-4 boards, which are inaccessible). */
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id").references(() => folders.id, { onDelete: "set null" }),
    /** Anyone with the link can view (read-only), even signed out. */
    isPublic: boolean("is_public").notNull().default(false),
    /** Object path in the private thumbnails bucket. */
    thumbnailPath: text("thumbnail_path"),
    /**
     * Highest board_updates.seq allocated so far. Appends reserve seqs by incrementing it
     * under the row lock, so several sync instances can write one board safely (Phase 5).
     */
    lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
    /**
     * End-to-end encrypted (Phase 9): every stored update/snapshot of this board is an
     * AES-GCM envelope the server can't read, and `title` is a placeholder. Set at creation,
     * never changed.
     */
    isPrivate: boolean("is_private").notNull().default(false),
    /** Private boards: the real title, encrypted in the browser with the board key. */
    encryptedTitle: bytea("encrypted_title"),
    /** Private boards: a known plaintext encrypted with the key, to verify a key before use. */
    keyCheck: bytea("key_check"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /**
     * Set while the board is above its owner's plan's board limit (Phase 10): read-only for
     * everyone, never deleted. Cleared when the owner upgrades or frees a slot.
     */
    planLockedAt: timestamp("plan_locked_at", { withTimezone: true }),
  },
  (t) => [
    index("boards_owner_id_idx").on(t.ownerId),
    index("boards_org_id_idx").on(t.orgId),
    index("boards_folder_id_idx").on(t.folderId),
    check(
      "boards_private_key_check",
      sql`${t.isPrivate} = (${t.keyCheck} is not null) and (${t.isPrivate} or ${t.encryptedTitle} is null)`,
    ),
  ],
).enableRLS();

/**
 * Write-ahead log: every Yjs update, in order, until compaction folds it into a snapshot and
 * moves it to board_update_archive.
 */
export const boardUpdates = pgTable(
  "board_updates",
  {
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    update: bytea("update").notNull(),
    /** Yjs client id of the sending connection (from its presence), if known. */
    clientId: bigint("client_id", { mode: "number" }),
    /** Guest id until Phase 4, then the signed-in user id. */
    userId: text("user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.seq] })],
).enableRLS();

/** Full document state up to and including `seq_upto`. Every snapshot is kept (replay seek points). */
export const boardSnapshots = pgTable(
  "board_snapshots",
  {
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    seqUpto: bigint("seq_upto", { mode: "number" }).notNull(),
    state: bytea("state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.seqUpto] })],
).enableRLS();

/** Compacted updates, kept for session replay (Phase 8): the full edit history of a board. */
export const boardUpdateArchive = pgTable(
  "board_update_archive",
  {
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    update: bytea("update").notNull(),
    clientId: bigint("client_id", { mode: "number" }),
    userId: text("user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.seq] })],
).enableRLS();

export type Board = typeof boards.$inferSelect;

export const ORG_ROLES = ["owner", "admin", "member"] as const;
export const BOARD_ROLES = ["owner", "editor", "viewer"] as const;
export const SHARE_ROLES = ["editor", "viewer"] as const;

export const orgKind = pgEnum("org_kind", ["personal", "team"]);
export const orgRole = pgEnum("org_role", ORG_ROLES);
export const boardRole = pgEnum("board_role", BOARD_ROLES);
/** Roles that can be granted by link or invite (ownership is never shared that way). */
export const shareRole = pgEnum("share_role", SHARE_ROLES);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

/** Workspaces. Every user gets a personal one on first sign-in; team workspaces come later. */
export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: orgKind("kind").notNull(),
  createdBy: uuid("created_by").references(() => authUsers.id, { onDelete: "set null" }),
  ...timestamps,
}).enableRLS();

export const memberships = pgTable(
  "memberships",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    role: orgRole("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.userId] }),
    index("memberships_user_id_idx").on(t.userId),
  ],
).enableRLS();

/** One level of folders per workspace. */
export const folders = pgTable(
  "folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdBy: uuid("created_by").references(() => authUsers.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [index("folders_org_id_idx").on(t.orgId)],
).enableRLS();

export const boardMembers = pgTable(
  "board_members",
  {
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    role: boardRole("role").notNull(),
    addedBy: uuid("added_by").references(() => authUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.boardId, t.userId] }),
    index("board_members_user_id_idx").on(t.userId),
  ],
).enableRLS();

/** Share links. Only a SHA-256 hash of the token is stored; the token is shown once. */
export const shareLinks = pgTable(
  "share_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    role: shareRole("role").notNull(),
    createdBy: uuid("created_by").references(() => authUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("share_links_board_id_idx").on(t.boardId)],
).enableRLS();

/** Email invites to a board; accepted by signing in with that email. */
export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    /** Lower-cased. */
    email: text("email").notNull(),
    role: shareRole("role").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: uuid("invited_by").references(() => authUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedBy: uuid("accepted_by").references(() => authUsers.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("invites_board_id_idx").on(t.boardId), index("invites_email_idx").on(t.email)],
).enableRLS();

/** Last time each user opened each board ("Recent"). */
export const boardVisits = pgTable(
  "board_visits",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    lastOpenedAt: timestamp("last_opened_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.boardId] })],
).enableRLS();

/**
 * Append-only record of every share, permission and deletion action. No foreign keys on
 * purpose: entries must outlive the boards and users they mention.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id"),
    boardId: uuid("board_id"),
    actorId: uuid("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_logs_board_id_idx").on(t.boardId, t.createdAt),
    index("audit_logs_org_id_idx").on(t.orgId, t.createdAt),
  ],
).enableRLS();

export type BoardRole = (typeof BOARD_ROLES)[number];
export type ShareRole = (typeof SHARE_ROLES)[number];
export type OrgRole = (typeof ORG_ROLES)[number];

// ── Phase 7: plans and AI reviews ───────────────────────────────────────────────────────────

export const planEnum = pgEnum("plan", PLANS);

export const entitlementSource = pgEnum("entitlement_source", ENTITLEMENT_SOURCES);

/**
 * Why a user has a plan: one row per grant (Phase 10). Derived from subscriptions, team
 * seats and student trials by apps/server (never written by hand); `manual` rows come from
 * the dev-only plan:set script / support. No row = Free. The effective plan is the best grant
 * whose `valid_until` is still in the future — compared at every check, so a late background
 * job can never extend paid time.
 */
export const entitlements = pgTable(
  "entitlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    plan: planEnum("plan").notNull().default("free"),
    source: entitlementSource("source").notNull().default("manual"),
    /** Subscription id, team org id, student trial id or "manual". */
    sourceId: text("source_id").notNull().default("manual"),
    /** Team seats: the organization whose seat this is (AI reviews pooled across it). */
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    /** Team seats: the subscription's seat count (the pool size). */
    seats: integer("seats"),
    /** Replaces the plan's monthly AI review allowance when set (support, trials). */
    aiReviewsPerMonthOverride: integer("ai_reviews_per_month_override"),
    /** The grant stops counting at this instant; null = open-ended. */
    validUntil: timestamp("valid_until", { withTimezone: true }),
    /**
     * The billing sweep has applied this grant's expiry (limits enforced, email sent).
     * Cleared whenever valid_until changes.
     */
    expiryProcessedAt: timestamp("expiry_processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("entitlements_user_source_idx").on(t.userId, t.source, t.sourceId),
    index("entitlements_valid_until_idx").on(t.validUntil),
  ],
).enableRLS();

export const REVIEW_STATUSES = ["running", "completed", "failed"] as const;
export const reviewStatus = pgEnum("review_status", REVIEW_STATUSES);

/**
 * AI design reviews of a board. A `running` row is inserted before Claude is called: it
 * reserves one review of the requester's monthly allowance, so parallel requests can't
 * exceed it. Failed reviews don't count, except ones the user aborted after the call began.
 */
export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    requestedBy: uuid("requested_by").references(() => authUsers.id, { onDelete: "set null" }),
    status: reviewStatus("status").notNull().default("running"),
    problemStatement: text("problem_statement").notNull().default(""),
    requirements: text("requirements").notNull().default(""),
    /**
     * The extracted graph that was reviewed (what the finding shape ids refer to). Null only
     * while a private board's review runs without the user opting in to storing it: that row
     * is a quota reservation with no content, deleted when the review ends.
     */
    graph: jsonb("graph").$type<unknown>(),
    graphFormatVersion: integer("graph_format_version").notNull(),
    /** Rule-engine findings given to the model as grounding. */
    ruleFindings: jsonb("rule_findings").$type<unknown>().notNull().default([]),
    /** The validated review (null until completed). */
    result: jsonb("result").$type<unknown>(),
    model: text("model").notNull(),
    errorCode: text("error_code"),
    /**
     * Set when an interviewer (or observer) ran the review during an interview: such reviews
     * are visible only to that interview's interviewers and observers, never the candidate.
     */
    // Cascade, not "set null": a null would make an interview-private review public.
    interviewId: uuid("interview_id").references((): AnyPgColumn => interviews.id, {
      onDelete: "cascade",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("reviews_board_id_idx").on(t.boardId, t.createdAt),
    index("reviews_requested_by_idx").on(t.requestedBy, t.createdAt),
    index("reviews_interview_id_idx").on(t.interviewId),
  ],
).enableRLS();

export const AI_CALL_KINDS = ["review", "hint"] as const;
export const AI_CALL_STATUSES = [
  "ok",
  "error",
  "refused",
  "truncated",
  "invalid_output",
  "aborted",
] as const;
export type AiCallKind = (typeof AI_CALL_KINDS)[number];
export type AiCallStatus = (typeof AI_CALL_STATUSES)[number];

/**
 * One row per Claude API call (successful or not): tokens and cost, for quotas, the daily
 * spend kill-switch and cost reporting. No foreign keys on purpose: spend records must
 * outlive the boards and users they mention.
 */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id"),
    boardId: uuid("board_id"),
    reviewId: uuid("review_id"),
    kind: text("kind", { enum: AI_CALL_KINDS }).notNull(),
    model: text("model").notNull(),
    status: text("status", { enum: AI_CALL_STATUSES }).notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    /** Cost in millionths of a US dollar (exact integer arithmetic). */
    costUsdMicros: bigint("cost_usd_micros", { mode: "number" }).notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    /** Anthropic's request id, for support tickets. */
    requestId: text("request_id"),
    /** Graph fingerprint for hints (skips identical repeat requests). */
    fingerprint: text("fingerprint"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ai_usage_created_at_idx").on(t.createdAt),
    index("ai_usage_user_kind_idx").on(t.userId, t.kind, t.createdAt),
  ],
).enableRLS();

export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

// ── Phase 8: interview mode ────────────────────────────────────────────────────────────────

export const interviewStatus = pgEnum("interview_status", INTERVIEW_STATUSES);
export const interviewRole = pgEnum("interview_role", INTERVIEW_ROLES);

/**
 * A live interview on a board. The question (hints included) is copied in at start, so later
 * edits to the question bank never change past interviews. At most one active interview per
 * board. `version` increases with every change to what participants see.
 */
export const interviews = pgTable(
  "interviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    startedBy: uuid("started_by").references(() => authUsers.id, { onDelete: "set null" }),
    status: interviewStatus("status").notNull().default("active"),
    question: jsonb("question").$type<unknown>().notNull(),
    /** Indexes into question.hints that the candidate has been shown. */
    revealedHints: jsonb("revealed_hints").$type<number[]>().notNull().default([]),
    durationMs: integer("duration_ms").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    pausedMs: bigint("paused_ms", { mode: "number" }).notNull().default(0),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    version: integer("version").notNull().default(0),
  },
  (t) => [
    index("interviews_board_id_idx").on(t.boardId, t.startedAt),
    uniqueIndex("interviews_one_active_per_board")
      .on(t.boardId)
      .where(sql`${t.status} = 'active'`),
  ],
).enableRLS();

/** Who plays which part. Anyone on the board without a row sees only what a candidate sees. */
export const interviewParticipants = pgTable(
  "interview_participants",
  {
    interviewId: uuid("interview_id")
      .notNull()
      .references(() => interviews.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    role: interviewRole("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.interviewId, t.userId] }),
    index("interview_participants_user_id_idx").on(t.userId),
  ],
).enableRLS();

/** Interviewers' private notes. Returned only to the interview's interviewers, over REST. */
export const interviewNotes = pgTable(
  "interview_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    interviewId: uuid("interview_id")
      .notNull()
      .references(() => interviews.id, { onDelete: "cascade" }),
    authorId: uuid("author_id").references(() => authUsers.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    ...timestamps,
  },
  (t) => [index("interview_notes_interview_id_idx").on(t.interviewId, t.createdAt)],
).enableRLS();

/** One rubric scorecard per interviewer. */
export const interviewScorecards = pgTable(
  "interview_scorecards",
  {
    interviewId: uuid("interview_id")
      .notNull()
      .references(() => interviews.id, { onDelete: "cascade" }),
    interviewerId: uuid("interviewer_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    scores: jsonb("scores").$type<unknown>().notNull().default({}),
    recommendation: text("recommendation"),
    summary: text("summary").notNull().default(""),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.interviewId, t.interviewerId] })],
).enableRLS();

/** Timeline of interview actions (replay markers): hints revealed, timer changes, start/end. */
export const interviewEvents = pgTable(
  "interview_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    interviewId: uuid("interview_id")
      .notNull()
      .references(() => interviews.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    actorId: uuid("actor_id"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("interview_events_interview_id_idx").on(t.interviewId, t.createdAt)],
).enableRLS();

/** Links to an interview's summary (sign-in required; never for the candidate). Hash only. */
export const interviewShareLinks = pgTable(
  "interview_share_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    interviewId: uuid("interview_id")
      .notNull()
      .references(() => interviews.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdBy: uuid("created_by").references(() => authUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("interview_share_links_interview_id_idx").on(t.interviewId)],
).enableRLS();

// ── Phase 10: billing ───────────────────────────────────────────────────────────────────────

export const billingProvider = pgEnum("billing_provider", BILLING_PROVIDERS);
export const billingInterval = pgEnum("billing_interval", BILLING_INTERVALS);
export const subscriptionStatus = pgEnum("subscription_status", SUBSCRIPTION_STATUSES);
export const INVOICE_STATUSES = ["paid", "issued", "failed", "cancelled"] as const;
export const invoiceStatus = pgEnum("invoice_status", INVOICE_STATUSES);

/**
 * The price list (seeded by migration). Provider-side plan ids differ per environment (test
 * vs live mode), so they are server configuration, not rows.
 */
export const plans = pgTable("plans", {
  id: text("id").primaryKey(),
  tier: planEnum("tier").notNull(),
  interval: billingInterval("interval").notNull(),
  currency: text("currency").notNull(),
  /** Minor units (paise); per seat for Team. */
  amountMinor: integer("amount_minor").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

/**
 * Our copy of a provider subscription. Always overwritten with the provider's current state
 * (fetched, never taken from a webhook body), so event order doesn't matter. Belongs to an
 * organization: Pro → the purchaser's personal workspace, Team → a team workspace. No
 * cascading deletes: billing records outlive workspaces.
 */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "set null" }),
    /** Who bought it (manages it; receives billing emails). */
    userId: uuid("user_id").references(() => authUsers.id, { onDelete: "set null" }),
    provider: billingProvider("provider").notNull(),
    providerSubscriptionId: text("provider_subscription_id").notNull(),
    providerCustomerId: text("provider_customer_id"),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id),
    status: subscriptionStatus("status").notNull(),
    /** Seats (Team); 1 for Pro. */
    quantity: integer("quantity").notNull().default(1),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    nextChargeAt: timestamp("next_charge_at", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    /** Set at the first failed payment; the plan is kept until then (7 days). */
    graceUntil: timestamp("grace_until", { withTimezone: true }),
    graceReminderSentAt: timestamp("grace_reminder_sent_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    hasScheduledChange: boolean("has_scheduled_change").notNull().default(false),
    couponCode: text("coupon_code"),
    /** The coupon's redemption was counted (exactly once, at the first activation). */
    couponRedeemedAt: timestamp("coupon_redeemed_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("subscriptions_provider_id_idx").on(t.provider, t.providerSubscriptionId),
    index("subscriptions_org_id_idx").on(t.orgId),
    index("subscriptions_user_id_idx").on(t.userId),
    // One paid subscription per workspace: a second checkout must be a plan change instead.
    uniqueIndex("subscriptions_one_live_per_org")
      .on(t.orgId)
      .where(sql`${t.status} in ('authenticated', 'active', 'past_due', 'halted')`),
  ],
).enableRLS();

/**
 * Every webhook delivery we accepted, keyed by the provider's event id. Inserted first, in
 * the same transaction as its effects: a redelivered event conflicts and changes nothing.
 * Ids and type only — no customer data from the payload.
 */
export const billingEvents = pgTable(
  "billing_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: billingProvider("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    providerSubscriptionId: text("provider_subscription_id"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("billing_events_provider_event_idx").on(t.provider, t.providerEventId)],
).enableRLS();

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "set null",
    }),
    /** Copied from the subscription so invoices stay listable if it goes away. */
    orgId: uuid("org_id"),
    userId: uuid("user_id"),
    provider: billingProvider("provider").notNull(),
    providerInvoiceId: text("provider_invoice_id").notNull(),
    providerPaymentId: text("provider_payment_id"),
    status: invoiceStatus("status").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    receiptUrl: text("receipt_url"),
    /** The receipt email was handed to the mailer (at most once). */
    receiptSentAt: timestamp("receipt_sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("invoices_provider_invoice_idx").on(t.provider, t.providerInvoiceId),
    index("invoices_subscription_id_idx").on(t.subscriptionId),
    index("invoices_org_id_idx").on(t.orgId, t.issuedAt),
  ],
).enableRLS();

/** Discount codes, each mapped to a provider offer (created in the provider's dashboard). */
export const coupons = pgTable("coupons", {
  /** Upper-case. */
  code: text("code").primaryKey(),
  provider: billingProvider("provider").notNull(),
  providerOfferId: text("provider_offer_id").notNull(),
  description: text("description").notNull(),
  /** Catalog plan ids it applies to; null = all. */
  planIds: text("plan_ids").array(),
  validFrom: timestamp("valid_from", { withTimezone: true }),
  validUntil: timestamp("valid_until", { withTimezone: true }),
  maxRedemptions: integer("max_redemptions"),
  redemptions: integer("redemptions").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

/**
 * Student offers (Pro for 3 months). One per user and one per email address ever: the hash
 * stays when the account is deleted, so re-creating it can't restart the trial.
 */
export const studentTrials = pgTable("student_trials", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .unique()
    .references(() => authUsers.id, { onDelete: "set null" }),
  /** SHA-256 of the lower-cased email. */
  emailHash: text("email_hash").notNull().unique(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
}).enableRLS();

/**
 * Who may edit a board beyond its owner: a seat is claimed the first time someone connects
 * (or writes) with edit access. The owner's plan caps the seats; seats above the cap are
 * suspended (read-only), in claim order, and come back when the owner upgrades.
 */
export const boardEditorSeats = pgTable(
  "board_editor_seats",
  {
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    suspended: boolean("suspended").notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.boardId, t.userId] }),
    index("board_editor_seats_user_id_idx").on(t.userId),
  ],
).enableRLS();

export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type InvoiceRow = typeof invoices.$inferSelect;
export type EntitlementRow = typeof entitlements.$inferSelect;
