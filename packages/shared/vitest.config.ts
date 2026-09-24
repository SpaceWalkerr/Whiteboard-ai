import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { defineConfig } from "vitest/config";

// The RLS test needs a real Supabase database. Use DATABASE_URL from the environment (CI) or
// from apps/server/.env (local), the same database `pnpm dev` migrates.
const serverEnvFile = new URL("../../apps/server/.env", import.meta.url);
const serverDotEnv = existsSync(serverEnvFile) ? parseEnv(readFileSync(serverEnvFile, "utf8")) : {};
const databaseUrl = process.env.DATABASE_URL ?? serverDotEnv.DATABASE_URL;

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    env: databaseUrl ? { DATABASE_URL: databaseUrl } : {},
    // The RLS test migrates a real database; give container cold starts some room.
    hookTimeout: 30_000,
  },
});
