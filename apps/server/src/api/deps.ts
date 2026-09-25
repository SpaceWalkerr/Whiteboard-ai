import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { Database } from "@whiteboard/shared/db";
import type { LanguageModel } from "../ai/model";
import type { HintSettings, ReviewSettings } from "../ai/reviewer";
import type { TicketIssuer } from "../auth/tickets";
import type { TokenVerifier } from "../auth/verifier";
import type { Mailer } from "../email/mailer";
import type { BoardRepository } from "../persistence/repository";
import type { RevocationBus } from "../revocation/bus";
import type { ThumbnailStorage } from "../storage/thumbnails";

export interface ApiDeps {
  db: Database;
  verifier: TokenVerifier;
  tickets: TicketIssuer;
  mailer: Mailer;
  revocations: RevocationBus;
  logger: Logger;
  /** Public web app URL, for links in emails. */
  appUrl: string;
  /** Shared rate-limit store across instances; in-memory when absent. */
  redis?: Redis | undefined;
  /** Board thumbnails; absent when no service key is configured (thumbnails disabled). */
  thumbnails?: ThumbnailStorage | undefined;
  /** Board content, for duplication. */
  boardStore?: BoardRepository | undefined;
  /** Bearer secret for internal cron endpoints; absent = endpoints disabled. */
  cronSecret?: string | undefined;
  /** AI reviews and hints; absent (or without a model) = AI routes answer 503. */
  ai?: AiConfig | undefined;
}

export interface AiConfig {
  /** Claude client; undefined when no API key is configured. */
  model: LanguageModel | undefined;
  /** Global switch (AI_ENABLED). */
  enabled: boolean;
  /** Daily spend kill-switch across all users (AI_DAILY_SPEND_LIMIT_USD). */
  dailySpendLimitUsd: number;
  review: ReviewSettings;
  hints: HintSettings & { perHour: number };
  /** Largest graph (components + connections) accepted. */
  maxElements: number;
}

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
