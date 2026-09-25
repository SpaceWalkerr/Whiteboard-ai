import type { AddressInfo } from "node:net";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { WebSocket } from "ws";
import {
  SyncProvider,
  type SyncProviderOptions,
  type SyncStatus,
  type WebSocketLike,
} from "@whiteboard/shared/sync";
import type { App } from "../src/app";
import { allowAllConnections, type AuthorizeConnection } from "../src/sync/auth";
import { createSyncMetrics, type SyncMetrics } from "../src/sync/metrics";
import type { RevocationBus } from "../src/revocation/bus";
import { attachSyncServer, type ClusterOptions, type SyncServer } from "../src/sync/upgrade";
import { MemoryBoardRepository } from "../src/persistence/memoryRepository";
import type { BoardRepository } from "../src/persistence/repository";
import { silentLogger, testApp } from "./helpers";

export const ORIGIN = "http://localhost:5173";

export interface TestServer {
  app: App;
  sync: SyncServer;
  metrics: SyncMetrics;
  port: number;
  httpUrl: string;
  wsUrl: string;
  stop: () => Promise<void>;
}

export async function startServer(
  options: {
    port?: number;
    graceMs?: number;
    perSecond?: number;
    burst?: number;
    bytesPerSecond?: number;
    bytesBurst?: number;
    authorize?: AuthorizeConnection;
    metricsToken?: string;
    repository?: BoardRepository;
    flushMs?: number;
    snapshotEvery?: number;
    /** One of several instances sharing rooms through Redis. */
    cluster?: ClusterOptions;
    revocations?: RevocationBus;
  } = {},
): Promise<TestServer> {
  const metrics = createSyncMetrics();
  const app = testApp({ metrics: { registry: metrics.registry, token: options.metricsToken } });
  const sync = attachSyncServer(app.server, {
    isAllowedOrigin: (origin) => origin === ORIGIN,
    authorize: options.authorize ?? allowAllConnections,
    logger: silentLogger,
    metrics,
    roomGraceMs: options.graceMs ?? 50,
    rateLimit: {
      perSecond: options.perSecond ?? 1000,
      burst: options.burst ?? 1000,
      bytesPerSecond: options.bytesPerSecond ?? 64 * 1024 * 1024,
      bytesBurst: options.bytesBurst ?? 64 * 1024 * 1024,
    },
    repository: options.repository ?? new MemoryBoardRepository(),
    flushMs: options.flushMs ?? 5,
    snapshotEvery: options.snapshotEvery ?? 500,
    cluster: options.cluster,
    revocations: options.revocations,
  });
  await app.listen({ host: "127.0.0.1", port: options.port ?? 0 });
  const { port } = app.server.address() as AddressInfo;
  return {
    app,
    sync,
    metrics,
    port,
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    stop: async () => {
      await sync.close();
      await app.close();
    },
  };
}

export interface TestClient {
  doc: Y.Doc;
  awareness: Awareness;
  provider: SyncProvider;
  statuses: SyncStatus[];
}

/** A real SyncProvider (the same class the browser uses) over the `ws` client. */
export function connectClient(
  wsUrl: string,
  boardId: string,
  options: {
    getTicket?: SyncProviderOptions["getTicket"];
    /** Fixed Yjs/awareness client id (to impersonate another client in spoofing tests). */
    clientId?: number;
    /** Reconnect an existing tab: same document and awareness (e.g. to another instance). */
    reuse?: { doc: Y.Doc; awareness: Awareness };
  } = {},
): TestClient {
  const doc = options.reuse?.doc ?? new Y.Doc();
  if (options.clientId !== undefined) doc.clientID = options.clientId;
  const awareness = options.reuse?.awareness ?? new Awareness(doc);
  const provider = new SyncProvider({
    serverUrl: wsUrl,
    boardId,
    doc,
    awareness,
    ...(options.getTicket ? { getTicket: options.getTicket } : {}),
    createSocket: (url, protocols) => {
      const ws = new WebSocket(url, protocols, { origin: ORIGIN });
      // Node's `ws` emits an error when closed mid-handshake; browsers don't. The provider
      // handles reconnects via onclose, so the event itself needs no handling.
      ws.on("error", () => undefined);
      return ws as unknown as WebSocketLike;
    },
    network: null,
    backoff: { initialMs: 20, maxMs: 200 },
    scheduleFlush: (flush) => {
      setImmediate(flush);
    },
  });
  const statuses: SyncStatus[] = [provider.getStatus()];
  provider.subscribe(() => {
    statuses.push(provider.getStatus());
  });
  return { doc, awareness, provider, statuses };
}

export async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Converged docs hold the same data, but map iteration order may differ: compare canonically. */
export function sameState(a: Y.Doc, b: Y.Doc): boolean {
  return canonical(a.getMap("shapes").toJSON()) === canonical(b.getMap("shapes").toJSON());
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([x], [y]) =>
      x.localeCompare(y),
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Resolves with the HTTP status of a refused upgrade, or 101 if it was accepted. */
export function upgradeStatus(wsUrl: string, path: string, origin?: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${wsUrl}${path}`, origin === undefined ? {} : { origin });
    ws.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on("open", () => {
      resolve(101);
      ws.close();
    });
    ws.on("error", () => undefined);
  });
}

/** Opens a raw socket to a room and resolves with the close code once the server closes it. */
export function rawSocket(
  wsUrl: string,
  boardId: string = crypto.randomUUID(),
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl}/rooms/${boardId}`, { origin: ORIGIN });
    ws.on("open", () => {
      resolve(ws);
    });
    ws.on("error", reject);
  });
}

export function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.on("close", (code) => {
      resolve(code);
    });
  });
}
