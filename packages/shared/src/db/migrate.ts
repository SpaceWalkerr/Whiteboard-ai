// CLI entry: `pnpm db:migrate`. Reads DATABASE_URL (from apps/server/.env locally).
import { z } from "zod";
import { EnvValidationError, loadEnv } from "../env";
import { serverEnvSchema } from "../env/server";
import { createDb } from "./client";
import { runMigrations } from "./migrations";

const migrateEnvSchema = z.object({ DATABASE_URL: serverEnvSchema.shape.DATABASE_URL });

async function main(): Promise<void> {
  const env = loadEnv(migrateEnvSchema, process.env);
  const { db, sql } = createDb(env.DATABASE_URL, { max: 1, applicationName: "whiteboard-migrate" });
  const target = new URL(env.DATABASE_URL);
  try {
    process.stdout.write(`Applying migrations to ${target.hostname}:${target.port || "5432"}...\n`);
    await runMigrations(db);
    process.stdout.write("Migrations up to date.\n");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  if (error instanceof EnvValidationError) {
    process.stderr.write(`${error.message}\n`);
  } else if (isConnectionRefused(error)) {
    process.stderr.write(
      "Could not connect to Postgres. Check DATABASE_URL in apps/server/.env.\n",
    );
  } else {
    process.stderr.write(
      `Migration failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  process.exit(1);
});

function isConnectionRefused(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && error.code === "ECONNREFUSED"
  );
}
