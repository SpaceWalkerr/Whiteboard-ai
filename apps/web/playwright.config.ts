import { defineConfig, devices } from "@playwright/test";
import { e2eEnv } from "./e2e/env";

// E2E needs a real Postgres (boards are persisted) and a real Supabase Auth project (users sign
// in for real): values come from the environment (CI) or apps/server/.env and apps/web/.env.

const API_PORT = 4000;
const WEB_PORT = 4173;
const isCI = Boolean(process.env.CI);

// E2E runs the real server and a production build of the web app (with its service worker)
// with the test-only debug hooks enabled (VITE_DEBUG_TOOLS).
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
      testIgnore: /\.perf\.ts$/,
    },
    // `pnpm perf`: not part of CI (shared runners give meaningless frame rates).
    {
      name: "perf",
      testMatch: /\.perf\.ts$/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
      timeout: 120_000,
    },
  ],
  webServer: [
    {
      command: "pnpm --filter @whiteboard/server exec tsx src/index.ts",
      url: `http://localhost:${API_PORT}/healthz`,
      reuseExistingServer: !isCI,
      timeout: 60_000,
      env: {
        NODE_ENV: "test",
        PORT: String(API_PORT),
        CORS_ALLOWED_ORIGINS: `http://localhost:${WEB_PORT}`,
        APP_URL: `http://localhost:${WEB_PORT}`,
        ...(e2eEnv.databaseUrl ? { DATABASE_URL: e2eEnv.databaseUrl } : {}),
        ...(e2eEnv.supabaseUrl ? { SUPABASE_URL: e2eEnv.supabaseUrl } : {}),
        ...(e2eEnv.ticketSecret ? { ROOM_TICKET_SECRET: e2eEnv.ticketSecret } : {}),
      },
    },
    {
      command: "pnpm build && pnpm preview",
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: !isCI,
      timeout: 120_000,
      env: {
        VITE_API_URL: `http://localhost:${API_PORT}`,
        VITE_WS_URL: `ws://localhost:${API_PORT}`,
        VITE_DEBUG_TOOLS: "true",
      },
    },
  ],
});
