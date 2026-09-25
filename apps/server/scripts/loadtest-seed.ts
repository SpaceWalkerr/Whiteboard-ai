// Seeds load-test data into the database in DATABASE_URL and writes room tickets for k6.
//
//   tsx --env-file=.env scripts/loadtest-seed.ts <scenario> [wsUrl]
//     scenario a: 1 board, 50 members          → loadtest/.data/seed-a.json
//     scenario b: 200 boards, 10 members each  → loadtest/.data/seed-b.json
//   tsx --env-file=.env scripts/loadtest-seed.ts cleanup
//
// Users are real auth.users rows (…@loadtest.whiteboard.invalid) with real memberships, so
// every upgrade runs the normal ticket + database access check. Tickets are valid for 5
// minutes (reusable within that time): seed right before a run. Never point this at
// production: it refuses unless NODE_ENV is development/test.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  boardMembers,
  boards,
  createDb,
  memberships,
  organizations,
  type Database,
  type SqlClient,
} from "@whiteboard/shared/db";
import { TicketIssuer } from "../src/auth/tickets";

const EMAIL_DOMAIN = "loadtest.whiteboard.invalid";
const SCENARIOS = { a: { rooms: 1, members: 50 }, b: { rooms: 200, members: 10 } } as const;
const outDir = fileURLToPath(new URL("../../../loadtest/.data/", import.meta.url));

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function createUsers(sql: SqlClient, count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, () => crypto.randomUUID());
  for (const [i, id] of ids.entries()) {
    await sql`insert into auth.users (id, email, aud, role, raw_user_meta_data)
              values (${id}, ${`load-${i}-${id.slice(0, 8)}@${EMAIL_DOMAIN}`},
                      'authenticated', 'authenticated', ${JSON.stringify({ full_name: `Load ${i}` })}::jsonb)`;
  }
  return ids;
}

async function createBoards(db: Database, ownerId: string, memberIds: string[], count: number) {
  const [org] = await db
    .insert(organizations)
    .values({ name: "Load test", kind: "personal", createdBy: ownerId })
    .returning({ id: organizations.id });
  if (!org) throw new Error("org insert failed");
  await db.insert(memberships).values({ orgId: org.id, userId: ownerId, role: "owner" });
  const ids = Array.from({ length: count }, () => crypto.randomUUID());
  await db.insert(boards).values(ids.map((id) => ({ id, ownerId, orgId: org.id })));
  await db.insert(boardMembers).values(
    ids.flatMap((boardId) =>
      memberIds.map((userId) => ({
        boardId,
        userId,
        role: userId === ownerId ? ("owner" as const) : ("editor" as const),
      })),
    ),
  );
  return ids;
}

async function cleanup(sql: SqlClient): Promise<void> {
  const users = await sql<{ id: string }[]>`
    select id from auth.users where email like ${`%@${EMAIL_DOMAIN}`}`;
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return;
  // Boards live in the load-test workspace, which cascades to them and their history.
  await sql`delete from organizations where created_by = any(${ids}::uuid[])`;
  await sql`delete from auth.users where id = any(${ids}::uuid[])`;
  process.stdout.write(`removed ${ids.length} load-test users and their boards\n`);
}

async function main(): Promise<void> {
  const env = process.env.NODE_ENV ?? "development";
  if (env !== "development" && env !== "test")
    throw new Error(`refusing to seed (NODE_ENV=${env})`);
  const [scenarioName, wsUrl = "ws://127.0.0.1:8080"] = process.argv.slice(2);
  const { db, sql } = createDb(required("DATABASE_URL"), {
    max: 2,
    applicationName: "loadtest-seed",
  });
  try {
    if (scenarioName === "cleanup") {
      await cleanup(sql);
      return;
    }
    if (scenarioName !== "a" && scenarioName !== "b")
      throw new Error("usage: loadtest-seed.ts <a|b|cleanup> [wsUrl]");
    const scenario = SCENARIOS[scenarioName];
    const users = await createUsers(sql, scenario.members);
    const [ownerId] = users;
    if (!ownerId) throw new Error("no users");
    const boardIds = await createBoards(db, ownerId, users, scenario.rooms);
    const tickets = new TicketIssuer(required("ROOM_TICKET_SECRET"));
    const rooms = [];
    for (const boardId of boardIds) {
      const members = [];
      for (const userId of users) {
        const { ticket } = await tickets.issue({
          userId,
          boardId,
          role: userId === ownerId ? "owner" : "editor",
          linkId: null,
          viaPublic: false,
        });
        members.push({ userId, ticket });
      }
      rooms.push({ boardId, members });
    }
    const origin = required("CORS_ALLOWED_ORIGINS").split(",")[0]?.trim() ?? "";
    mkdirSync(outDir, { recursive: true });
    const file = `${outDir}seed-${scenarioName}.json`;
    writeFileSync(file, JSON.stringify({ wsUrl, origin, rooms }));
    process.stdout.write(
      `seeded ${String(scenario.rooms)} board(s) × ${String(scenario.members)} members → ${file}\n` +
        `tickets expire in 5 minutes\n`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
