import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type { Logger } from "pino";
import { applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import { WebSocket, type RawData } from "ws";
import {
  CLOSE_CODES,
  encodeAwarenessMessage,
  encodeMessage,
  MESSAGE_AWARENESS,
  MESSAGE_SYNC,
  readAwarenessEntries,
  toUint8Array,
} from "@whiteboard/shared/sync";
import { can } from "../access/boardAccess";
import type { ConnectionIdentity } from "./auth";
import type { SyncMetrics } from "./metrics";
import type { TokenBucket } from "./rateLimit";
import type { Attribution } from "./roomPersistence";
import type { Room, RoomMember } from "./rooms";

export interface ConnectionOptions {
  rateLimiter: TokenBucket;
  byteLimiter: TokenBucket;
  metrics: SyncMetrics;
  logger: Logger;
  /** Close a client whose unsent data exceeds this; it reconnects and resyncs. */
  maxBufferedBytes: number;
  onClose: (connection: SyncConnection) => void;
}

/** Server side of one client socket in one room. */
export class SyncConnection implements RoomMember {
  /** Set by pong; cleared by each heartbeat. A connection that misses a beat is terminated. */
  private alive = true;
  private closing = false;
  /** Messages that arrive while the room is still loading from the database. */
  private buffered: { data: RawData; isBinary: boolean }[] | null = [];
  /** Set during shutdown: further edits are ignored (clients re-send them after reconnecting). */
  private frozen = false;

  constructor(
    private readonly ws: WebSocket,
    readonly room: Room,
    readonly identity: ConnectionIdentity,
    private readonly options: ConnectionOptions,
  ) {}

  start(): void {
    this.ws.on("message", (data, isBinary) => {
      // After shutdown begins, new edits are refused (unacknowledged; the client re-sends
      // them after reconnecting). Anything received before then is still applied and saved.
      if (this.frozen) return;
      if (this.buffered) this.buffered.push({ data, isBinary });
      else this.handleMessage(data, isBinary);
    });
    this.ws.on("pong", () => {
      this.alive = true;
    });
    this.ws.on("error", (error) => {
      this.options.logger.debug({ err: error, boardId: this.room.boardId }, "websocket error");
    });
    this.ws.on("close", (code) => {
      this.options.metrics.closed.inc({ code: String(code) });
      this.options.onClose(this);
    });

    void this.room.ready.then((load) => {
      if (!load.ok) {
        this.close(
          load.reason === "deleted" ? CLOSE_CODES.boardDeleted : CLOSE_CODES.internalError,
          load.reason === "deleted" ? "board deleted" : "board unavailable",
        );
        return;
      }
      this.beginSync();
      const queued = this.buffered ?? [];
      this.buffered = null;
      for (const { data, isBinary } of queued) this.handleMessage(data, isBinary);
    });
  }

  /** Who authored updates from this connection: its presence (guest id until Phase 4). */
  attribution(): Attribution {
    for (const [clientId, owner] of this.room.awarenessOwners) {
      if (owner !== this) continue;
      const state = this.room.awareness.getStates().get(clientId) as
        { user?: { id?: unknown } } | undefined;
      const userId = typeof state?.user?.id === "string" ? state.user.id : null;
      return { clientId, userId: this.identity.userId ?? userId };
    }
    return { clientId: null, userId: this.identity.userId };
  }

  /** Stop accepting new messages from this connection (graceful shutdown). */
  freeze(): void {
    this.frozen = true;
  }

  private beginSync(): void {
    // Start the handshake: send our state vector so the client sends what we're missing.
    this.send(
      encodeMessage(MESSAGE_SYNC, (encoder) => {
        syncProtocol.writeSyncStep1(encoder, this.room.doc);
      }),
    );
    const others = [...this.room.awareness.getStates().keys()];
    if (others.length > 0)
      this.send(encodeAwarenessMessage(encodeAwarenessUpdate(this.room.awareness, others)));
    this.send(this.room.persistedMessage());
  }

  send(message: Uint8Array): void {
    if (this.closing || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > this.options.maxBufferedBytes) {
      this.options.logger.warn({ boardId: this.room.boardId }, "closing slow consumer");
      this.close(CLOSE_CODES.slowConsumer, "slow consumer");
      return;
    }
    this.ws.send(message, { binary: true });
  }

  heartbeat(): void {
    if (!this.alive) {
      this.ws.terminate();
      return;
    }
    this.alive = false;
    this.ws.ping();
  }

  close(code: number, reason: string): void {
    if (this.closing) return;
    this.closing = true;
    this.ws.close(code, reason);
    // A peer that never answers the close handshake is dropped.
    setTimeout(() => {
      this.ws.terminate();
    }, 5_000).unref();
  }

  private handleMessage(data: RawData, isBinary: boolean): void {
    const size = Array.isArray(data)
      ? data.reduce((sum, b) => sum + b.byteLength, 0)
      : data.byteLength;
    if (!this.options.rateLimiter.take() || !this.options.byteLimiter.take(size)) {
      this.options.metrics.messages.inc({ type: "rate_limited" });
      this.close(CLOSE_CODES.rateLimited, "rate limit exceeded");
      return;
    }
    if (!isBinary || Array.isArray(data)) {
      this.close(CLOSE_CODES.invalidPayload, "binary messages only");
      return;
    }
    const message = toUint8Array(data);
    try {
      const decoder = decoding.createDecoder(message);
      const type = decoding.readVarUint(decoder);
      if (type === MESSAGE_SYNC) this.handleSync(decoder, message.byteLength);
      else if (type === MESSAGE_AWARENESS)
        this.handleAwareness(decoding.readVarUint8Array(decoder));
      else throw new Error(`unknown message type ${type}`);
    } catch (error) {
      this.options.logger.info(
        { err: error, boardId: this.room.boardId },
        "closing connection: invalid message",
      );
      this.close(CLOSE_CODES.invalidPayload, "invalid message");
    }
  }

  private handleSync(decoder: decoding.Decoder, bytes: number): void {
    const syncType = decoding.readVarUint(decoder);
    switch (syncType) {
      case syncProtocol.messageYjsSyncStep1: {
        this.options.metrics.messages.inc({ type: "sync_step1" });
        const reply = encoding.createEncoder();
        encoding.writeVarUint(reply, MESSAGE_SYNC);
        syncProtocol.readSyncStep1(decoder, reply, this.room.doc);
        this.send(encoding.toUint8Array(reply));
        return;
      }
      case syncProtocol.messageYjsSyncStep2:
      case syncProtocol.messageYjsUpdate: {
        this.options.metrics.messages.inc({
          type: syncType === syncProtocol.messageYjsUpdate ? "update" : "sync_step2",
        });
        // Viewers may read but never write. Their writes are dropped server-side, whatever
        // the client sends; the same permission table as the REST API decides.
        if (!can(this.identity.role, "write")) {
          this.options.metrics.messages.inc({ type: "write_denied" });
          return;
        }
        this.options.metrics.updateBytes.inc(bytes);
        syncProtocol.readSyncStep2(decoder, this.room.doc, this, (error) => {
          throw error;
        });
        return;
      }
      default:
        throw new Error(`unknown sync message ${syncType}`);
    }
  }

  /**
   * A presence client id belongs to the first connection that claims it. An id currently
   * held by a client of another instance may be taken over only by the same signed-in user:
   * that is the same browser tab reconnecting here after its instance went away (its old
   * state lingers on this instance until it times out).
   */
  private mayClaim(clientId: number): boolean {
    const owner = this.room.awarenessOwners.get(clientId);
    if (owner) return owner === this;
    if (!this.room.remoteAwareness.has(clientId)) return true;
    const state = this.room.awareness.getStates().get(clientId) as
      { user?: { id?: unknown } } | undefined;
    return this.identity.userId !== null && state?.user?.id === this.identity.userId;
  }

  private handleAwareness(update: Uint8Array): void {
    this.options.metrics.messages.inc({ type: "awareness" });
    const entries = readAwarenessEntries(update);
    if (!entries) {
      this.options.metrics.messages.inc({ type: "awareness_invalid" });
      return;
    }
    const { awarenessOwners, remoteAwareness } = this.room;
    if (entries.some(({ clientId }) => !this.mayClaim(clientId))) {
      this.options.metrics.messages.inc({ type: "awareness_spoofed" });
      return;
    }
    for (const { clientId } of entries) {
      awarenessOwners.set(clientId, this);
      remoteAwareness.delete(clientId);
    }
    applyAwarenessUpdate(this.room.awareness, update, this);
  }
}
