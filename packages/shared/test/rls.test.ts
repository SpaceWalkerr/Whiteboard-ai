// Security-critical: every table in `public` must have Row Level Security enabled and no
// policies for the anon/authenticated roles, so the public Supabase API can never read our
// data. This runs against a real database with all migrations applied.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, type SqlClient } from "../src/db";

let sql: SqlClient;

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set. Add your Supabase database URL to apps/server/.env.");
  }
  const client = createDb(databaseUrl, { max: 1, applicationName: "whiteboard-rls-test" });
  sql = client.sql;
  try {
    await sql`select 1`;
  } catch (error) {
    const { hostname, port } = new URL(databaseUrl);
    throw new Error(
      `Cannot reach Postgres at ${hostname}:${port}. Check DATABASE_URL in apps/server/.env. ` +
        `Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await runMigrations(client.db);
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("row level security", () => {
  it("is enabled on every table in the public schema", async () => {
    const tables = await sql<{ table_name: string; rls_enabled: boolean }[]>`
      select c.relname as table_name, c.relrowsecurity as rls_enabled
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
      order by c.relname`;

    expect(tables.map((t) => t.table_name)).toContain("profiles");
    const withoutRls = tables.filter((t) => !t.rls_enabled).map((t) => t.table_name);
    expect(withoutRls, "tables in public without RLS").toEqual([]);
  });

  it("grants no policies to the anon or authenticated roles", async () => {
    const policies = await sql<{ tablename: string; policyname: string }[]>`
      select tablename, policyname
      from pg_policies
      where schemaname = 'public'
        and roles && array['anon', 'authenticated', 'public']::name[]`;

    expect(policies).toEqual([]);
  });
});
