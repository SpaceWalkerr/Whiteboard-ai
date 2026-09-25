import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { defineConfig } from "vitest/config";

// Persistence and crash tests use a real Postgres: DATABASE_URL from the environment (CI) or
// from apps/server/.env (local development).
const envFile = new URL("./.env", import.meta.url);
const dotEnv = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
const databaseUrl = process.env.DATABASE_URL ?? dotEnv.DATABASE_URL;
// Multi-instance tests need a real Redis (a separate variable: the dev server itself runs
// without Redis). Locally: ~/.local/bin/redis-server, or the scale stack's Redis.
const testRedisUrl = process.env.TEST_REDIS_URL ?? dotEnv.TEST_REDIS_URL;

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    env: {
      NODE_ENV: "test",
      ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
      ...(testRedisUrl ? { TEST_REDIS_URL: testRedisUrl } : {}),
    },
    // Database round trips to a hosted Postgres can be slow.
    testTimeout: 60_000,
    // Test files share one (hosted) database: running them one at a time keeps timings
    // meaningful (the 2,000-shape load budget) and stays within the pooler's connection limit.
    fileParallelism: false,
    hookTimeout: 60_000,
  },
});
