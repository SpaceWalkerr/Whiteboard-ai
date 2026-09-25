import type { Redis } from "ioredis";
import type { Logger } from "pino";
import {
  decodeClusterMessage,
  encodeClusterMessage,
  type ClusterKind,
  type ClusterMessage,
} from "./envelope";

export type ClusterHandler = (message: ClusterMessage) => void;

/** What the sender fills in; `from` is always this instance. */
export interface OutgoingClusterMessage {
  kind: ClusterKind;
  payload: Uint8Array;
  to?: string | null;
}

/**
 * Fan-out of room traffic between sync instances. One channel per room; an instance is
 * subscribed to a room's channel exactly while it holds that room in memory.
 */
export interface RoomBus {
  readonly instanceId: string;
  /** Subscribes to the room's channel. Resolves once subscribed, so nothing published after
   *  that can be missed. Messages this instance published itself are never delivered. */
  join(boardId: string, handler: ClusterHandler): Promise<void>;
  leave(boardId: string): void;
  /** Fire-and-forget. Lost messages are repaired by the periodic resync (see RoomManager). */
  publish(boardId: string, message: OutgoingClusterMessage): void;
  /** Called after the connection to the bus came back (messages may have been lost). */
  onReconnect(handler: () => void): () => void;
  close(): Promise<void>;
}

/** Single instance (development without Redis, most tests): nobody else to talk to. */
export class LocalRoomBus implements RoomBus {
  constructor(readonly instanceId: string) {}

  join(): Promise<void> {
    return Promise.resolve();
  }

  leave(): void {
    // Nothing subscribed.
  }

  publish(): void {
    // No other instances.
  }

  onReconnect(): () => void {
    return () => undefined;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

export const roomChannel = (boardId: string): string => `wb:room:${boardId}`;

/** Traffic per kind is counted by the rooms; the bus reports only what it drops. */
export interface RoomBusMetrics {
  dropped(reason: "malformed" | "publish_failed"): void;
}

/**
 * Redis pub/sub. Publishes go through the shared command connection; subscriptions need a
 * dedicated connection (a subscribed Redis connection can't run other commands). ioredis
 * re-subscribes every channel after a reconnect; we then tell rooms to resync, because
 * anything published while we were disconnected is gone.
 */
export class RedisRoomBus implements RoomBus {
  private readonly subscriber: Redis;
  private readonly handlers = new Map<string, ClusterHandler>();
  private readonly reconnectHandlers = new Set<() => void>();
  private connectedOnce = false;

  constructor(
    readonly instanceId: string,
    private readonly publisher: Redis,
    private readonly logger: Logger,
    private readonly metrics?: RoomBusMetrics,
  ) {
    // The offline queue lets subscribe() wait for a (re)connect instead of failing at once.
    this.subscriber = publisher.duplicate({
      enableOfflineQueue: true,
      connectionName: "whiteboard-room-bus",
    });
    // Connection errors are already logged (throttled) by the command connection.
    this.subscriber.on("error", () => undefined);
    this.subscriber.on("ready", () => {
      if (this.connectedOnce) {
        logger.warn("room bus reconnected; resyncing rooms");
        for (const handler of this.reconnectHandlers) handler();
      }
      this.connectedOnce = true;
    });
    this.subscriber.on("messageBuffer", (channel: Buffer, data: Buffer) => {
      this.deliver(channel.toString(), data);
    });
  }

  async join(boardId: string, handler: ClusterHandler): Promise<void> {
    const channel = roomChannel(boardId);
    this.handlers.set(channel, handler);
    await this.subscriber.subscribe(channel);
  }

  leave(boardId: string): void {
    const channel = roomChannel(boardId);
    this.handlers.delete(channel);
    this.subscriber.unsubscribe(channel).catch((error: unknown) => {
      this.logger.debug({ err: error, boardId }, "room bus: unsubscribe failed");
    });
  }

  publish(boardId: string, message: OutgoingClusterMessage): void {
    const data = encodeClusterMessage({
      from: this.instanceId,
      kind: message.kind,
      payload: message.payload,
      to: message.to ?? null,
    });
    this.publisher.publish(roomChannel(boardId), Buffer.from(data)).catch((error: unknown) => {
      this.metrics?.dropped("publish_failed");
      this.logger.debug({ err: error, boardId }, "room bus: publish failed");
    });
  }

  onReconnect(handler: () => void): () => void {
    this.reconnectHandlers.add(handler);
    return () => this.reconnectHandlers.delete(handler);
  }

  async close(): Promise<void> {
    this.handlers.clear();
    this.reconnectHandlers.clear();
    try {
      await this.subscriber.quit();
    } catch {
      this.subscriber.disconnect();
    }
  }

  private deliver(channel: string, data: Buffer): void {
    const handler = this.handlers.get(channel);
    if (!handler) return;
    const message = decodeClusterMessage(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
    if (!message) {
      this.metrics?.dropped("malformed");
      this.logger.warn({ channel }, "room bus: ignored malformed message");
      return;
    }
    // Our own publications come back to us; replies addressed to someone else aren't ours.
    if (message.from === this.instanceId) return;
    if (message.to !== null && message.to !== this.instanceId) return;
    handler(message);
  }
}
