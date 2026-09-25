import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { Logger } from "pino";
import { WebSocketServer } from "ws";
import {
  boardIdSchema,
  CLOSE_CODES,
  encodeInterviewMessage,
  MAX_CLIENT_MESSAGE_BYTES,
  SYNC_SUBPROTOCOL,
} from "@whiteboard/shared/sync";
import { LocalLease, type PersistenceLease } from "../cluster/lease";
import { LocalRoomBus, type RoomBus } from "../cluster/roomBus";
import type { PublicInterviewState } from "@whiteboard/shared/interview";
import type { RevocationBus, RevocationEvent } from "../revocation/bus";
import type { AuthorizeConnection } from "./auth";
import { SyncConnection } from "./connection";
import type { SyncMetrics } from "./metrics";
import { TokenBucket } from "./rateLimit";
import { RoomManager, type RoomManagerOptions } from "./rooms";

export const ROOM_PATH = /^\/rooms\/([^/]+)$/;

export interface SyncServerOptions {
  isAllowedOrigin: (origin: string) => boolean;
  authorize: AuthorizeConnection;
  logger: Logger;
  metrics: SyncMetrics;
  roomGraceMs: number;
  /** Per connection: messages/second and bytes/second, each a token bucket. */
  rateLimit: { perSecond: number; burst: number; bytesPerSecond: number; bytesBurst: number };
  heartbeatMs?: number | undefined;
  maxBufferedBytes?: number | undefined;
  repository: RoomManagerOptions["repository"];
  /** Max time an update waits before being written (batching window). */
  flushMs: number;
  /** Compact into a snapshot after this many updates. */
  snapshotEvery: number;
  /** Access revocations; matching connections are closed at once. */
  revocations?: RevocationBus | undefined;
  /**
   * Running as one of several instances: room traffic travels over `bus` and `lease`
   * decides who persists each room. Omitted: a single instance (always the writer).
   */
  cluster?: ClusterOptions | undefined;
  /**
   * The board's interview as every participant may see it (public fields only), read from
   * the database. Sent to each socket when it joins and whenever the interview changes.
   */
  interviewState?: ((boardId: string) => Promise<PublicInterviewState | null>) | undefined;
}

export interface ClusterOptions {
  bus: RoomBus;
  lease: PersistenceLease;
  /** Lease renewal / takeover interval (a third of the lease TTL). */
  leaseRenewMs: number;
  /** Periodic resync with the other instances. */
  resyncMs: number;
}

export interface SyncServer {
  rooms: RoomManager;
  /**
   * Graceful shutdown: stop accepting connections and edits, flush every pending update,
   * snapshot every active room, then close clients with "service restart" (they reconnect).
   * Best effort until `deadline` (epoch ms).
   */
  close(deadline?: number): Promise<void>;
}

/**
 * Yjs sync over WebSocket at /rooms/:boardId, sharing the HTTP port with Fastify. Every
 * upgrade checks the room id, the Origin header and authorization before the socket is
 * accepted.
 */
export function attachSyncServer(server: Server, options: SyncServerOptions): SyncServer {
  const { logger, metrics } = options;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CLIENT_MESSAGE_BYTES,
    // Echo the sync subprotocol (never the ticket) back to the client.
    handleProtocols: (protocols) => (protocols.has(SYNC_SUBPROTOCOL) ? SYNC_SUBPROTOCOL : false),
  });
  const rooms = new RoomManager({
    graceMs: options.roomGraceMs,
    metrics,
    logger,
    repository: options.repository,
    flushMs: options.flushMs,
    snapshotEvery: options.snapshotEvery,
    bus: options.cluster?.bus ?? new LocalRoomBus(randomUUID()),
    lease: options.cluster?.lease ?? new LocalLease(),
    leaseRenewMs: options.cluster?.leaseRenewMs ?? 5_000,
    resyncMs: options.cluster?.resyncMs ?? 15_000,
  });
  let accepting = true;
  const connections = new Set<SyncConnection>();

  const reject = (socket: Duplex, status: number, reason: string, metric: string) => {
    metrics.rejected.inc({ reason: metric });
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", (error) => {
      logger.debug({ err: error }, "upgrade socket error");
    });

    if (!accepting) {
      reject(socket, 503, "Service Unavailable", "shutting_down");
      return;
    }
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    const match = ROOM_PATH.exec(pathname);
    if (!match) {
      reject(socket, 404, "Not Found", "not_found");
      return;
    }
    let boardId: string;
    try {
      boardId = decodeURIComponent(match[1] ?? "");
    } catch {
      boardId = "";
    }
    if (!boardIdSchema.safeParse(boardId).success) {
      reject(socket, 400, "Bad Request", "bad_room");
      return;
    }

    const origin = request.headers.origin;
    if (origin === undefined || !options.isAllowedOrigin(origin)) {
      logger.warn({ origin }, "websocket upgrade rejected: origin not allowed");
      reject(socket, 403, "Forbidden", "origin");
      return;
    }

    options.authorize(request, boardId).then(
      (result) => {
        if (!result.ok) {
          reject(
            socket,
            result.status,
            result.status === 401 ? "Unauthorized" : "Forbidden",
            "unauthorized",
          );
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          const room = rooms.acquire(boardId);
          const connection = new SyncConnection(ws, room, result.identity, {
            rateLimiter: new TokenBucket(options.rateLimit.burst, options.rateLimit.perSecond),
            byteLimiter: new TokenBucket(
              options.rateLimit.bytesBurst,
              options.rateLimit.bytesPerSecond,
            ),
            metrics,
            logger,
            maxBufferedBytes: options.maxBufferedBytes ?? 4 * 1024 * 1024,
            onClose: (closed) => {
              connections.delete(closed);
              metrics.connectionsActive.set(connections.size);
              rooms.leave(closed.room, closed);
            },
          });
          rooms.join(room, connection);
          logger.info(
            { boardId, userId: result.identity.userId, role: result.identity.role },
            "sync connection opened",
          );
          connections.add(connection);
          metrics.connectionsActive.set(connections.size);
          connection.start();
          void room.ready.then((load) => {
            if (load.ok) void sendInterviewState(boardId, [connection]);
          });
        });
      },
      (error: unknown) => {
        logger.error({ err: error, boardId }, "authorization failed");
        reject(socket, 500, "Internal Server Error", "error");
      },
    );
  });

  /** Loads the board's public interview state and sends it to the given sockets. */
  const sendInterviewState = async (boardId: string, targets: SyncConnection[]) => {
    if (!options.interviewState || targets.length === 0) return;
    try {
      const state = await options.interviewState(boardId);
      if (state === null) return;
      const message = encodeInterviewMessage({ ...state, serverNow: Date.now() });
      for (const connection of targets) connection.send(message);
    } catch (error) {
      logger.error({ err: error, boardId }, "could not send interview state");
    }
  };

  const affects = (connection: SyncConnection, event: RevocationEvent): boolean => {
    if (connection.room.boardId !== event.boardId) return false;
    switch (event.type) {
      case "interview":
        return false;
      case "board_deleted":
        return true;
      case "member":
        return connection.identity.userId === event.userId;
      case "link":
        return connection.identity.linkId === event.linkId;
      case "public_off":
        return connection.identity.viaPublic;
    }
  };
  const unsubscribeRevocations = options.revocations?.subscribe((event) => {
    if (event.type === "interview") {
      const targets = [...connections].filter((c) => c.room.boardId === event.boardId);
      void sendInterviewState(event.boardId, targets);
      return;
    }
    for (const connection of connections) {
      if (!affects(connection, event)) continue;
      metrics.messages.inc({ type: "revoked" });
      if (event.type === "board_deleted")
        connection.close(CLOSE_CODES.boardDeleted, "board deleted");
      else connection.close(CLOSE_CODES.accessChanged, "access changed");
    }
  });

  const heartbeat = setInterval(() => {
    for (const connection of connections) connection.heartbeat();
  }, options.heartbeatMs ?? 30_000);
  heartbeat.unref();

  return {
    rooms,
    close: async (deadline = Date.now() + 20_000) => {
      accepting = false;
      clearInterval(heartbeat);
      unsubscribeRevocations?.();
      for (const connection of connections) connection.freeze();
      await rooms.flushAll(deadline);
      for (const connection of connections)
        connection.close(CLOSE_CODES.serviceRestart, "server restarting");
      await new Promise<void>((resolve) => {
        wss.close(() => {
          resolve();
        });
      });
      rooms.destroy();
    },
  };
}
