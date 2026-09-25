// Sets a user's plan (development and test only — billing sets plans from Phase 10).
//
//   pnpm --filter @whiteboard/server plan:set <email> <free|pro|team> [reviewsPerMonth]
//
// The optional third argument overrides the plan's monthly AI review allowance (e.g. 1, to
// see the "quota reached" prompt quickly); "-" clears the override. Writes an audit row.
import { PLANS, type Plan } from "@whiteboard/shared/plans";
import { createDb, entitlements, profiles, eq } from "@whiteboard/shared/db";
import { audit } from "../src/audit/audit";

async function main(): Promise<void> {
  const [email, plan, override] = process.argv.slice(2);
  if (!email || !plan || !(PLANS as readonly string[]).includes(plan)) {
    throw new Error("usage: plan:set <email> <free|pro|team> [reviewsPerMonth|-]");
  }
  const env = process.env.NODE_ENV ?? "development";
  if (env !== "development" && env !== "test")
    throw new Error(`refusing to change plans with NODE_ENV=${env}; billing owns plans there`);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const reviewsOverride =
    override === undefined || override === "-" ? null : Number.parseInt(override, 10);
  if (reviewsOverride !== null && (!Number.isInteger(reviewsOverride) || reviewsOverride < 0))
    throw new Error("reviewsPerMonth must be a non-negative integer");

  const { db, sql } = createDb(url, { max: 1, applicationName: "whiteboard-set-plan" });
  try {
    const [profile] = await db
      .select({ id: profiles.id })
      .from(profiles)
      .where(eq(profiles.email, email.toLowerCase()));
    if (!profile) throw new Error(`no user with email ${email} (sign in once first)`);
    await db.transaction(async (tx) => {
      await tx
        .insert(entitlements)
        .values({
          userId: profile.id,
          plan: plan as Plan,
          aiReviewsPerMonthOverride: reviewsOverride,
        })
        .onConflictDoUpdate({
          target: entitlements.userId,
          set: {
            plan: plan as Plan,
            aiReviewsPerMonthOverride: reviewsOverride,
            updatedAt: new Date(),
          },
        });
      await audit(tx, {
        action: "entitlement.change",
        actorId: null,
        targetType: "entitlement",
        targetId: profile.id,
        metadata: { plan, aiReviewsPerMonthOverride: reviewsOverride, via: "plan:set script" },
      });
    });
    process.stdout.write(
      `${email}: plan=${plan}${reviewsOverride === null ? "" : `, reviews/month=${String(reviewsOverride)}`}\n`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
