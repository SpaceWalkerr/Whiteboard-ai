export * from "./schema";
export { createDb, type Database, type DbOptions, type SqlClient } from "./client";
export { migrationsFolder, runMigrations } from "./migrations";
// Query helpers re-exported so apps use the same drizzle-orm instance as the schema (pnpm can
// otherwise resolve a second copy with different optional peers, which breaks the types).
export { and, asc, count, desc, eq, gt, inArray, lt, lte, sql } from "drizzle-orm";
export type { PgUpdateSetSource } from "drizzle-orm/pg-core";
