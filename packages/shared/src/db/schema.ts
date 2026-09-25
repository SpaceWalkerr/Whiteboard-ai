import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { authUsers } from "drizzle-orm/supabase";

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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("boards_owner_id_idx").on(t.ownerId),
    index("boards_org_id_idx").on(t.orgId),
    index("boards_folder_id_idx").on(t.folderId),
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
