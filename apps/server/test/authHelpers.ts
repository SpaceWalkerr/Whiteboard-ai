import type { AddressInfo } from "node:net";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { WebSocket } from "ws";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import {
  boardMembers,
  boards,
  memberships,
  organizations,
  sql as dsql,
  type Database,
  type SqlClient,
} from "@whiteboard/shared/db";
import { SyncProvider, type TicketResult, type WebSocketLike } from "@whiteboard/shared/sync";
import type { ApiDeps } from "../src/api/deps";
import { TicketIssuer } from "../src/auth/tickets";
import { createTokenVerifier } from "../src/auth/verifier";
import { MemoryMailer } from "../src/email/mailer";
import { PgBoardRepository } from "../src/persistence/pgRepository";
import { LocalRevocationBus } from "../src/revocation/bus";
import { createSyncMetrics } from "../src/sync/metrics";
import { loadPublicState } from "../src/interview/service";
import { ticketAuthorizer } from "../src/sync/ticketAuth";
import { attachSyncServer, type SyncServer } from "../src/sync/upgrade";
import { silentLogger, testApp } from "./helpers";
import { ORIGIN } from "./syncHelpers";

export const TEST_ISSUER = "https://test-project.supabase.co/auth/v1";
export const TEST_TICKET_SECRET = "test-ticket-secret-0123456789abcdef-0123456789";

export interface TestUser {
  id: string;
  email: string;
  name: string;
}

/** Signs Supabase-shaped access tokens with a local key; the server verifies them normally. */
export async function createTestAuth() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "ES256" };
  const verifier = createTokenVerifier({
    issuer: TEST_ISSUER,
    keys: createLocalJWKSet({ keys: [jwk] }),
  });
  const sign = (user: TestUser, options: { expiresIn?: string | number; issuer?: string } = {}) =>
    new SignJWT({
      role: "authenticated",
      email: user.email,
      user_metadata: { full_name: user.name },
    })
      .setProtectedHeader({ alg: "ES256", kid: "test-key" })
      .setIssuer(options.issuer ?? TEST_ISSUER)
      .setAudience("authenticated")
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime(options.expiresIn ?? "10m")
      .sign(privateKey);
  return { verifier, sign };
}

/** Real rows in auth.users (our tables reference them). Clean up with deleteAuthUsers. */
export async function createAuthUser(sql: SqlClient, name: string): Promise<TestUser> {
  const id = crypto.randomUUID();
  const email = `${name.toLowerCase().replace(/\W/g, "")}-${id.slice(0, 8)}@test.whiteboard.invalid`;
  await sql`insert into auth.users (id, email, aud, role, raw_user_meta_data)
            values (${id}, ${email}, 'authenticated', 'authenticated', ${JSON.stringify({ full_name: name })}::jsonb)`;
  return { id, email, name };
}

export async function deleteAuthUsers(sql: SqlClient, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  // Personal workspaces (and their boards) are owned by these users.
  await sql`delete from organizations where created_by = any(${ids}::uuid[])`;
  await sql`delete from auth.users where id = any(${ids}::uuid[])`;
}

/** A board owned by `owner` in a fresh personal workspace, created directly in the database. */
export async function createOwnedBoard(db: Database, owner: TestUser): Promise<string> {
  const [org] = await db
    .insert(organizations)
    .values({ name: "Test workspace", kind: "personal", createdBy: owner.id })
    .returning({ id: organizations.id });
  if (!org) throw new Error("org insert failed");
  await db.insert(memberships).values({ orgId: org.id, userId: owner.id, role: "owner" });
  const id = crypto.randomUUID();
  await db.insert(boards).values({ id, ownerId: owner.id, orgId: org.id });
  await db.insert(boardMembers).values({ boardId: id, userId: owner.id, role: "owner" });
  return id;
}

/** A bare board row (no workspace or owner): enough for persistence-only tests. */
export async function createBareBoard(db: Database): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(boards).values({ id });
  return id;
}

export async function deleteBoards(db: Database, ids: string[]): Promise<void> {
  if (ids.length > 0) await db.execute(dsql`delete from boards where id = any(${ids}::uuid[])`);
}

export interface ApiServer {
  url: string;
  wsUrl: string;
  mailer: MemoryMailer;
  revocations: LocalRevocationBus;
  sync: SyncServer;
  tickets: TicketIssuer;
  request: (
    method: string,
    path: string,
    options?: {
      token?: string;
      body?: unknown;
      rawBody?: Uint8Array;
      headers?: Record<string, string>;
    },
  ) => Promise<{ status: number; body: unknown }>;
  stop: () => Promise<void>;
}

/** The real API + sync server (ticket-authorized, Postgres-backed), on a random port. */
export async function startApiServer(
  db: Database,
  verifier: ApiDeps["verifier"],
  extras: Pick<ApiDeps, "thumbnails" | "cronSecret" | "ai"> & {
    /** Share events with other instances (e.g. a RedisRevocationBus); local by default. */
    revocations?: LocalRevocationBus;
  } = {},
): Promise<ApiServer> {
  const mailer = new MemoryMailer();
  const repository = new PgBoardRepository(db);
  const { revocations = new LocalRevocationBus(), ...apiExtras } = extras;
  const tickets = new TicketIssuer(TEST_TICKET_SECRET);
  const metrics = createSyncMetrics();
  const app = testApp({
    api: {
      db,
      verifier,
      tickets,
      mailer,
      revocations,
      logger: silentLogger,
      appUrl: "http://app.test",
      boardStore: repository,
      ...apiExtras,
    },
  });
  const sync = attachSyncServer(app.server, {
    isAllowedOrigin: (origin) => origin === ORIGIN,
    authorize: ticketAuthorizer(tickets, db),
    logger: silentLogger,
    metrics,
    roomGraceMs: 50,
    rateLimit: {
      perSecond: 1000,
      burst: 1000,
      bytesPerSecond: 64 * 1024 * 1024,
      bytesBurst: 64 * 1024 * 1024,
    },
    repository,
    flushMs: 10,
    snapshotEvery: 500,
    revocations,
    interviewState: (boardId) => loadPublicState(db, boardId),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    wsUrl: `ws://127.0.0.1:${port}`,
    mailer,
    revocations,
    sync,
    tickets,
    request: async (method, path, options = {}) => {
      const res = await fetch(`${url}${path}`, {
        method,
        headers: {
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
          ...options.headers,
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        ...(options.rawBody !== undefined ? { body: options.rawBody } : {}),
      });
      const text = await res.text();
      return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null };
    },
    stop: async () => {
      await sync.close();
      await app.close();
    },
  };
}

export interface TicketedClient {
  doc: Y.Doc;
  provider: SyncProvider;
  closeCodes: number[];
}

/** A real SyncProvider that fetches its ticket from the API before every (re)connect. */
export function ticketedClient(
  server: ApiServer,
  boardId: string,
  auth: { token?: string; shareToken?: string },
): TicketedClient {
  const doc = new Y.Doc();
  const closeCodes: number[] = [];
  const provider = new SyncProvider({
    serverUrl: server.wsUrl,
    boardId,
    doc,
    awareness: new Awareness(doc),
    network: null,
    backoff: { initialMs: 20, maxMs: 200 },
    scheduleFlush: (flush) => {
      setImmediate(flush);
    },
    createSocket: (url, protocols) => {
      const ws = new WebSocket(url, protocols, { origin: ORIGIN });
      ws.on("error", () => undefined);
      ws.on("close", (code) => closeCodes.push(code));
      return ws as unknown as WebSocketLike;
    },
    getTicket: async (): Promise<TicketResult> => {
      const res = await server.request("POST", `/boards/${boardId}/ticket`, {
        ...(auth.token ? { token: auth.token } : {}),
        body: auth.shareToken ? { shareToken: auth.shareToken } : {},
      });
      if (res.status === 200) return { ok: true, ticket: (res.body as { ticket: string }).ticket };
      if (res.status === 401) return { ok: false, reason: "unauthorized" };
      if (res.status === 403) return { ok: false, reason: "forbidden" };
      if (res.status === 404) return { ok: false, reason: "not_found" };
      return { ok: false, reason: "error" };
    },
  });
  return { doc, provider, closeCodes };
}
