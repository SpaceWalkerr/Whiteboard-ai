import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

function readEnvFile(relative: string): Record<string, string | undefined> {
  const file = new URL(relative, import.meta.url);
  return existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
}

const server = readEnvFile("../../server/.env");
const web = readEnvFile("../.env");

/** Settings for E2E runs: the process environment (CI) wins over the local .env files. */
export const e2eEnv = {
  databaseUrl: process.env.DATABASE_URL ?? server.DATABASE_URL,
  supabaseUrl: process.env.SUPABASE_URL ?? server.SUPABASE_URL ?? web.VITE_SUPABASE_URL,
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? server.SUPABASE_SERVICE_ROLE_KEY,
  publishableKey: process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? web.VITE_SUPABASE_PUBLISHABLE_KEY,
  ticketSecret: process.env.ROOM_TICKET_SECRET ?? server.ROOM_TICKET_SECRET,
};
