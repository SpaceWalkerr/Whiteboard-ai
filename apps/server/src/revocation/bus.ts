import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { z } from "zod";

/**
 * Access changes that must end live sessions immediately. Each is published to every server
 * instance (via Redis when configured); sync connections that match are closed and must
 * fetch a new ticket, which re-checks access.
 */
export const revocationEventSchema = z.discriminatedUnion("type", [
  /** A member's role changed or they were removed. */
  z.object({ type: z.literal("member"), boardId: z.uuid(), userId: z.uuid() }),
  z.object({ type: z.literal("link"), boardId: z.uuid(), linkId: z.uuid() }),
  z.object({ type: z.literal("public_off"), boardId: z.uuid() }),
  z.object({ type: z.literal("board_deleted"), boardId: z.uuid() }),
]);
export type RevocationEvent = z.infer<typeof revocationEventSchema>;

export interface RevocationBus {
  publish(event: RevocationEvent): Promise<void>;
  subscribe(handler: (event: RevocationEvent) => void): () => void;
  close(): Promise<void>;
}

/** Single instance (development, tests). */
export class LocalRevocationBus implements RevocationBus {
  protected readonly handlers = new Set<(event: RevocationEvent) => void>();

  publish(event: RevocationEvent): Promise<void> {
    this.deliver(event);
    return Promise.resolve();
  }

  subscribe(handler: (event: RevocationEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): Promise<void> {
    this.handlers.clear();
    return Promise.resolve();
  }

  protected deliver(event: RevocationEvent): void {
    for (const handler of this.handlers) handler(event);
  }
}

const CHANNEL = "whiteboard:revocations";

/**
 * Multi-instance: delivers locally at once and fans out through Redis pub/sub to the other
 * instances. If Redis is unavailable, local delivery still happens and the failure is logged.
 */
export class RedisRevocationBus extends LocalRevocationBus {
  private readonly instanceId = crypto.randomUUID();
  private readonly subscriber: Redis;

  constructor(
    private readonly publisher: Redis,
    private readonly logger: Logger,
  ) {
    super();
    this.subscriber = publisher.duplicate({ enableOfflineQueue: true });
    this.subscriber.on("error", () => undefined);
    void this.subscriber.subscribe(CHANNEL).catch((error: unknown) => {
      logger.warn({ err: error }, "revocation bus: could not subscribe");
    });
    this.subscriber.on("message", (_channel: string, raw: string) => {
      try {
        const parsed = z
          .object({ from: z.string(), event: revocationEventSchema })
          .parse(JSON.parse(raw));
        if (parsed.from !== this.instanceId) this.deliver(parsed.event);
      } catch {
        logger.warn("revocation bus: ignored malformed message");
      }
    });
  }

  override async publish(event: RevocationEvent): Promise<void> {
    this.deliver(event);
    try {
      await this.publisher.publish(CHANNEL, JSON.stringify({ from: this.instanceId, event }));
    } catch (error) {
      this.logger.error(
        { err: error, event },
        "revocation bus: publish failed (delivered locally only)",
      );
    }
  }

  override async close(): Promise<void> {
    await super.close();
    this.subscriber.disconnect();
  }
}
