import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { clientIp } from "../src/http/clientIp";
import { createWindowLimiter } from "../src/http/windowLimiter";
import type { AuthorizeConnection } from "../src/sync/auth";
import { ORIGIN, startServer, upgradeStatus, type TestServer } from "./syncHelpers";

let servers: TestServer[] = [];
afterEach(async () => {
  for (const s of servers) await s.stop().catch(() => undefined);
  servers = [];
});

function request(remoteAddress: string, forwardedFor?: string): IncomingMessage {
  return {
    socket: { remoteAddress },
    headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor },
  } as unknown as IncomingMessage;
}

describe("clientIp", () => {
  it("uses the socket address when no proxy is trusted, ignoring X-Forwarded-For", () => {
    expect(clientIp(request("10.0.0.1", "1.2.3.4"), 0)).toBe("10.0.0.1");
  });

  it("takes the address the trusted proxy saw, not what the client wrote", () => {
    // The client forged "6.6.6.6"; Render's load balancer appended the real address.
    expect(clientIp(request("10.0.0.1", "6.6.6.6, 1.2.3.4"), 1)).toBe("1.2.3.4");
    expect(clientIp(request("10.0.0.1", "1.2.3.4"), 1)).toBe("1.2.3.4");
    // More trusted hops than addresses: the leftmost one.
    expect(clientIp(request("10.0.0.1"), 2)).toBe("10.0.0.1");
  });
});

describe("window limiter (in memory)", () => {
  it("allows max hits per key per window, then refuses until the next window", async () => {
    let now = 0;
    const limiter = createWindowLimiter({ max: 2, windowMs: 1000, prefix: "t:", now: () => now });
    expect(await limiter.hit("a")).toBe(true);
    expect(await limiter.hit("a")).toBe(true);
    expect(await limiter.hit("a")).toBe(false);
    expect(await limiter.hit("b")).toBe(true);
    now = 1000;
    expect(await limiter.hit("a")).toBe(true);
  });
});

describe("WebSocket upgrade limits", () => {
  const board = () => `/rooms/${crypto.randomUUID()}`;

  it("answers 429 once an IP has used its upgrades, before authorizing", async () => {
    let authorized = 0;
    const authorize: AuthorizeConnection = () => {
      authorized += 1;
      return Promise.resolve({
        ok: true,
        identity: {
          userId: null,
          role: "editor",
          linkId: null,
          viaPublic: false,
          encrypted: false,
        },
      });
    };
    const s = await startServer({
      authorize,
      upgradeLimits: {
        perIp: createWindowLimiter({ max: 3, windowMs: 60_000, prefix: "t:" }),
        trustProxy: 0,
        maxConnectionsPerUser: 100,
      },
    });
    servers.push(s);
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push(await upgradeStatus(s.wsUrl, board(), ORIGIN));
    expect(statuses).toEqual([101, 101, 101, 429, 429]);
    // Refused upgrades never reach token verification or the database.
    expect(authorized).toBe(3);
  });

  it("caps the sockets one signed-in user holds open", async () => {
    const userId = crypto.randomUUID();
    const s = await startServer({
      authorize: () =>
        Promise.resolve({
          ok: true,
          identity: { userId, role: "editor", linkId: null, viaPublic: false, encrypted: false },
        }),
      upgradeLimits: {
        perIp: createWindowLimiter({ max: 1000, windowMs: 60_000, prefix: "t:" }),
        trustProxy: 0,
        maxConnectionsPerUser: 2,
      },
    });
    servers.push(s);
    const { WebSocket } = await import("ws");
    const open = (path: string) =>
      new Promise<InstanceType<typeof WebSocket>>((resolve, reject) => {
        const ws = new WebSocket(`${s.wsUrl}${path}`, { origin: ORIGIN });
        ws.on("open", () => {
          resolve(ws);
        });
        ws.on("error", reject);
      });
    const first = await open(board());
    const second = await open(board());
    expect(await upgradeStatus(s.wsUrl, board(), ORIGIN)).toBe(429);
    // Closing one frees a slot.
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await upgradeStatus(s.wsUrl, board(), ORIGIN)).toBe(101);
    second.close();
  });
});
