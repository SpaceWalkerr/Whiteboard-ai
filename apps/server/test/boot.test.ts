// Acceptance: a missing required env var must stop the server at boot with a clear message.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("server boot", () => {
  it("exits 1 and names the missing variables when required env is absent", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: serverDir,
      // Deliberately omit the required vars; keep PATH so node can run.
      env: { PATH: process.env.PATH },
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Refusing to start");
    expect(result.stderr).toContain("DATABASE_URL: is required");
    expect(result.stderr).toContain("CORS_ALLOWED_ORIGINS");
    expect(result.stderr).not.toContain("REDIS_URL");
  });
});
