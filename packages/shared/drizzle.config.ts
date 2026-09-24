import { defineConfig } from "drizzle-kit";

// Only `drizzle-kit generate` is used; migrations are applied by src/db/migrate.ts.
// schemaFilter keeps drizzle-kit away from Supabase-owned schemas (auth, storage, ...).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  schemaFilter: ["public"],
  strict: true,
  verbose: true,
});
