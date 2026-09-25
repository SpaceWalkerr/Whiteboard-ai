import { defineConfig, devices } from "@playwright/test";

const API_PORT = 4000;
const WEB_PORT = 4173;
const isCI = Boolean(process.env.CI);

// E2E runs the real server and a production build of the web app with the test-only debug
// hooks enabled (VITE_DEBUG_TOOLS). /healthz never touches the database, and Postgres
// connections are opened lazily, so a placeholder DATABASE_URL is enough when none is provided.
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
        NODE_ENV: "production",
        LOG_LEVEL: "warn",
        PORT: String(API_PORT),
        DATABASE_URL:
          process.env.DATABASE_URL ?? "postgresql://unused:unused@127.0.0.1:5432/unused",
        // Production mode requires Redis; nothing in these tests reaches it.
        REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
        CORS_ALLOWED_ORIGINS: `http://localhost:${WEB_PORT}`,
        // Production mode requires a metrics token; this one only guards the E2E server.
        METRICS_TOKEN: "e2e-metrics-token-0123456789abcdef",
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
