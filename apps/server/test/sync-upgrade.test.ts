import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORIGIN, startServer, upgradeStatus, type TestServer } from "./syncHelpers";

let server: TestServer;
const BOARD = crypto.randomUUID();
const PRIVATE = crypto.randomUUID();

beforeAll(async () => {
  server = await startServer({
    authorize: (_request, boardId) =>
      Promise.resolve(
        boardId === PRIVATE
          ? { ok: false, status: 403 }
          : {
              ok: true,
              identity: { userId: null, role: "editor", linkId: null, viaPublic: false },
            },
      ),
  });
});

afterAll(async () => {
  await server.stop();
});

describe("WebSocket upgrade on the HTTP port", () => {
  it("accepts an allowed origin on /rooms/:boardId", async () => {
    expect(await upgradeStatus(server.wsUrl, `/rooms/${BOARD}`, ORIGIN)).toBe(101);
  });

  it("rejects a disallowed or missing Origin with 403", async () => {
    expect(await upgradeStatus(server.wsUrl, `/rooms/${BOARD}`, "https://evil.example.com")).toBe(
      403,
    );
    expect(await upgradeStatus(server.wsUrl, `/rooms/${BOARD}`)).toBe(403);
  });

  it("rejects invalid board ids with 400", async () => {
    expect(await upgradeStatus(server.wsUrl, "/rooms/bad%20id", ORIGIN)).toBe(400);
    expect(await upgradeStatus(server.wsUrl, "/rooms/not-a-uuid", ORIGIN)).toBe(400);
    expect(await upgradeStatus(server.wsUrl, `/rooms/${"x".repeat(65)}`, ORIGIN)).toBe(400);
  });

  it("returns 404 for other paths", async () => {
    expect(await upgradeStatus(server.wsUrl, "/sync", ORIGIN)).toBe(404);
  });

  it("runs the authorization hook before accepting the socket", async () => {
    expect(await upgradeStatus(server.wsUrl, `/rooms/${PRIVATE}`, ORIGIN)).toBe(403);
  });

  it("still serves REST on the same port", async () => {
    expect((await fetch(`${server.httpUrl}/healthz`)).status).toBe(200);
  });
});
