import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export interface DbOptions {
  /** Max pooled connections for this process. */
  max?: number;
  /** Application name shown in pg_stat_activity; helps when debugging the pooler. */
  applicationName?: string;
}

/**
 * Creates a postgres.js pool and a Drizzle instance over it. Connections are opened lazily,
 * so creating the client never blocks boot; readiness checks surface an unreachable DB.
 * We use the pooler in session mode, so prepared statements are safe (see CLAUDE.md).
 */
export function createDb(url: string, options: DbOptions = {}) {
  const sql = postgres(url, {
    max: options.max ?? 10,
    connect_timeout: 5,
    idle_timeout: 30,
    connection: { application_name: options.applicationName ?? "whiteboard" },
    onnotice: () => undefined,
  });
  const db = drizzle(sql, { schema });
  return { sql, db };
}

export type Database = ReturnType<typeof createDb>["db"];
export type SqlClient = ReturnType<typeof createDb>["sql"];
