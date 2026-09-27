import type { Logger } from "pino";
import type { PlanId } from "@whiteboard/shared/billing";
import type { Database } from "@whiteboard/shared/db";
import type { Mailer, EmailMessage } from "../email/mailer";
import type { RevocationBus, RevocationEvent } from "../revocation/bus";
import type { BillingProvider } from "./provider";

/** Server configuration for billing; absent = checkout unavailable (development without keys). */
export interface BillingConfig {
  provider: BillingProvider;
  /** Our catalog plan id → the provider's plan id (per environment: test vs live). */
  providerPlanIds: Record<PlanId, string>;
}

export interface BillingContext {
  db: Database;
  mailer: Mailer;
  revocations: RevocationBus;
  logger: Logger;
  appUrl: string;
  now: () => Date;
  billing: BillingConfig | undefined;
}

/** Work to do after a billing transaction commits (never inside it). */
export interface Effects {
  emails: (() => Promise<EmailMessage>)[];
  revocations: RevocationEvent[];
}

export const noEffects = (): Effects => ({ emails: [], revocations: [] });

/**
 * Publishes access changes and sends emails once the transaction has committed. Emails are
 * best effort: a failure is logged, never retried (the money state is already correct).
 */
export async function runEffects(ctx: BillingContext, effects: Effects): Promise<void> {
  for (const event of effects.revocations) {
    await ctx.revocations.publish(event).catch((error: unknown) => {
      ctx.logger.warn({ err: error, event }, "could not publish access change");
    });
  }
  for (const build of effects.emails) {
    try {
      await ctx.mailer.send(await build());
    } catch (error) {
      ctx.logger.error({ err: error }, "billing email failed");
    }
  }
}

export function planIdForProvider(config: BillingConfig, providerPlanId: string): PlanId | null {
  for (const [planId, id] of Object.entries(config.providerPlanIds))
    if (id === providerPlanId) return planId as PlanId;
  return null;
}
