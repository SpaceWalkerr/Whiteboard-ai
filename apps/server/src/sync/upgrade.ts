import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { Logger } from "pino";
import { WebSocketServer } from "ws";

export const SYNC_PATH = "/sync";

/** Close code sent to clients when the server restarts, telling them to reconnect. */
export const WS_CLOSE_SERVICE_RESTART = 1012;

export interface SyncUpgradeOptions {
  isAllowedOrigin: (origin: string) => boolean;
  logger: Logger;
}

/**
 * Shares the HTTP port with Fastify by handling `upgrade` events ourselves.
 * Phase 0 only enforces the Origin check; no connection is accepted until Phase 2 adds
 * JWT authentication and board authorization here, so there is never an unauthenticated socket.
 */
export function attachSyncServer(server: Server, options: SyncUpgradeOptions): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on("upgrade", (request: IncomingMessage, socket: Duplex) => {
    socket.on("error", (error) => {
      options.logger.debug({ err: error }, "upgrade socket error");
    });

    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    if (pathname !== SYNC_PATH) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }

    const origin = request.headers.origin;
    if (origin === undefined || !options.isAllowedOrigin(origin)) {
      options.logger.warn({ origin }, "websocket upgrade rejected: origin not allowed");
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }

    // Phase 2: verify the Supabase JWT and the caller's role on the board, then
    // wss.handleUpgrade(...). Until then every upgrade is refused.
    rejectUpgrade(socket, 401, "Unauthorized");
  });

  return wss;
}

/** Closes every open socket with "service restart" so clients reconnect to another instance. */
export async function closeSyncServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    client.close(WS_CLOSE_SERVICE_RESTART, "server restarting");
  }
  await new Promise<void>((resolve, reject) => {
    wss.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
