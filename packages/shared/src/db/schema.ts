import { sql } from "drizzle-orm";
import {
  bigint,
  customType,
  index,
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("boards_owner_id_idx").on(t.ownerId)],
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
