import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Database } from "./client";

export const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));

/** Applies pending migrations. Safe to run repeatedly; applied ones are skipped. */
export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder });
}
