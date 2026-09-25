import { boards, createDb, inArray, type Database, type SqlClient } from "@whiteboard/shared/db";

/** A real Postgres connection for persistence tests; fails loudly if none is configured. */
export async function connectTestDb(): Promise<{
  db: Database;
  sql: SqlClient;
  cleanup: (ids: string[]) => Promise<void>;
}> {
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new Error("DATABASE_URL is not set. Add your Supabase database URL to apps/server/.env.");
  const { db, sql } = createDb(url, { max: 4, applicationName: "whiteboard-test" });
  try {
    await sql`select 1`;
  } catch (error) {
    const { hostname, port } = new URL(url);
    throw new Error(
      `Cannot reach Postgres at ${hostname}:${port} (${error instanceof Error ? error.message : String(error)}). Run pnpm db:migrate and check DATABASE_URL.`,
    );
  }
  return {
    db,
    sql,
    cleanup: async (ids) => {
      if (ids.length > 0) await db.delete(boards).where(inArray(boards.id, ids));
    },
  };
}
