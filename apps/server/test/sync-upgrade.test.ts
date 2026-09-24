import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, type WebSocketServer } from "ws";
import type { App } from "../src/app";
import { attachSyncServer, closeSyncServer } from "../src/sync/upgrade";
import { isAllowedOrigin, silentLogger, testApp } from "./helpers";

let app: App;
let wss: WebSocketServer;
let baseUrl: string;

beforeAll(async () => {
  app = testApp();
  wss = attachSyncServer(app.server, { isAllowedOrigin, logger: silentLogger });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;
  baseUrl = `ws://127.0.0.1:${port}`;
});

afterAll(async () => {
  await closeSyncServer(wss);
  await app.close();
});

/** Resolves with the HTTP status the server answered the upgrade with. */
function upgradeStatus(path: string, origin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl}${path}`, origin === undefined ? {} : { origin });
    ws.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on("open", () => {
      ws.close();
      reject(new Error("upgrade unexpectedly accepted"));
    });
    ws.on("error", () => undefined);
  });
}

describe("WebSocket upgrade on the HTTP port", () => {
  it("rejects a disallowed Origin with 403", async () => {
    expect(await upgradeStatus("/sync", "https://evil.example.com")).toBe(403);
  });

  it("rejects a missing Origin with 403", async () => {
    expect(await upgradeStatus("/sync")).toBe(403);
  });

  it("refuses an allowed Origin with 401 until authentication exists", async () => {
    expect(await upgradeStatus("/sync", "http://localhost:5173")).toBe(401);
  });

  it("returns 404 for upgrades on other paths", async () => {
    expect(await upgradeStatus("/other", "http://localhost:5173")).toBe(404);
  });

  it("still serves REST on the same port", async () => {
    const res = await fetch(`${baseUrl.replace("ws", "http")}/healthz`);
    expect(res.status).toBe(200);
  });
});
