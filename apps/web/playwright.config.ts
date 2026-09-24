import { defineConfig, devices } from "@playwright/test";

const API_PORT = 4000;
const WEB_PORT = 4173;
const isCI = Boolean(process.env.CI);

// The smoke test runs the real server and a production build of the web app.
// /healthz never touches the database, and Postgres connections are opened lazily, so a
// placeholder DATABASE_URL is enough when none is provided.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
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
        CORS_ALLOWED_ORIGINS: `http://localhost:${WEB_PORT}`,
      },
    },
    {
      command: "pnpm build && pnpm preview",
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: !isCI,
      timeout: 120_000,
      env: { VITE_API_URL: `http://localhost:${API_PORT}` },
    },
  ],
});
