// Development only: pretend a user's paid time has run out, then run the billing sweep.
//
//   pnpm --filter @whiteboard/server billing:expire <email>
//
// Razorpay test mode can't fast-forward a month, so to see "features lock at period end" this
// moves the end of every paid grant (cancelled subscription, grace period, student trial,
// team seat) of that user to one second ago in OUR database and runs the same sweep the
// Render Cron runs: boards above the Free limit become read-only and the "downgraded" email
// is logged. Open sockets pick up their new role at their next reconnect (reload the page).
// A renewing (not cancelled) subscription is left alone: cancel it first in billing settings.
import pino from "pino";
import {
  and,
  createDb,
  entitlements,
  eq,
  profiles,
  sql,
  subscriptions,
} from "@whiteboard/shared/db";
import { runBillingSweep } from "../src/billing/service";
import { LogMailer } from "../src/email/mailer";
import { LocalRevocationBus } from "../src/revocation/bus";

async function main(): Promise<void> {
  const [email] = process.argv.slice(2);
  if (!email) throw new Error("usage: billing:expire <email>");
  const env = process.env.NODE_ENV ?? "development";
  if (env !== "development" && env !== "test")
    throw new Error(`refusing to rewrite billing dates with NODE_ENV=${env}`);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const { db, sql: client } = createDb(url, {
    max: 2,
    applicationName: "whiteboard-billing-expire",
  });
  try {
    const [profile] = await db
      .select({ id: profiles.id })
      .from(profiles)
      .where(eq(profiles.email, email.toLowerCase()));
    if (!profile) throw new Error(`no user with email ${email}`);
    const past = new Date(Date.now() - 1000);
    const moved = await db.transaction(async (tx) => {
      await tx
        .update(subscriptions)
        .set({ currentPeriodEnd: past })
        .where(
          and(eq(subscriptions.userId, profile.id), eq(subscriptions.cancelAtPeriodEnd, true)),
        );
      await tx
        .update(subscriptions)
        .set({ graceUntil: past })
        .where(
          and(eq(subscriptions.userId, profile.id), sql`${subscriptions.graceUntil} is not null`),
        );
      return tx
        .update(entitlements)
        .set({ validUntil: past, expiryProcessedAt: null })
        .where(
          and(
            eq(entitlements.userId, profile.id),
            sql`${entitlements.source} <> 'manual'`,
            sql`${entitlements.validUntil} is not null and ${entitlements.validUntil} > now()`,
          ),
        )
        .returning({ source: entitlements.source });
    });
    const logger = pino({ level: "info" });
    const result = await runBillingSweep({
      db,
      mailer: new LogMailer(logger),
      revocations: new LocalRevocationBus(),
      logger,
      appUrl: process.env.APP_URL ?? "http://localhost:5173",
      now: () => new Date(),
      billing: undefined,
    });
    process.stdout.write(
      `${email}: ended ${String(moved.length)} grant(s) (${moved.map((m) => m.source).join(", ") || "none"}); sweep ${JSON.stringify(result)}\n`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
