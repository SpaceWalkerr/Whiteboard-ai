import type { AddressInfo } from "node:net";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { WebSocket } from "ws";
import { SyncProvider, type SyncStatus, type WebSocketLike } from "@whiteboard/shared/sync";
import type { App } from "../src/app";
import { allowAllConnections, type AuthorizeConnection } from "../src/sync/auth";
import { createSyncMetrics, type SyncMetrics } from "../src/sync/metrics";
import { attachSyncServer, type SyncServer } from "../src/sync/upgrade";
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
export function connectClient(wsUrl: string, boardId: string): TestClient {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const provider = new SyncProvider({
    serverUrl: wsUrl,
    boardId,
    doc,
    awareness,
    createSocket: (url) => new WebSocket(url, { origin: ORIGIN }) as unknown as WebSocketLike,
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
export function rawSocket(wsUrl: string, boardId: string): Promise<WebSocket> {
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
