import type { AuthUser } from "../auth/verifier";
import { and, eq, memberships, organizations, profiles, sql } from "@whiteboard/shared/db";
import type { Tx } from "./deps";

/** Provider name, else the email's local part, else a generic name (blank strings don't count). */
export function displayNameFor(user: AuthUser): string {
  const candidates = [user.name?.trim(), user.email?.split("@")[0]];
  return candidates.find((c): c is string => c !== undefined && c.length > 0) ?? "Whiteboard user";
}

/** Creates or refreshes the profile and returns the user's personal workspace (creating it once). */
export async function ensureWorkspace(tx: Tx, user: AuthUser): Promise<string> {
  await tx
    .insert(profiles)
    .values({
      id: user.id,
      email: user.email,
      displayName: displayNameFor(user),
      avatarUrl: user.avatarUrl,
    })
    .onConflictDoUpdate({
      target: profiles.id,
      set: {
        email: user.email,
        avatarUrl: user.avatarUrl,
        displayName: sql`coalesce(${profiles.displayName}, excluded.display_name)`,
      },
    });

  const [existing] = await tx
    .select({ orgId: memberships.orgId })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(memberships.userId, user.id), eq(organizations.kind, "personal")))
    .limit(1);
  if (existing) return existing.orgId;

  const [org] = await tx
    .insert(organizations)
    .values({ name: `${displayNameFor(user)}'s workspace`, kind: "personal", createdBy: user.id })
    .returning({ id: organizations.id });
  if (!org) throw new Error("failed to create workspace");
  await tx.insert(memberships).values({ orgId: org.id, userId: user.id, role: "owner" });
  return org.id;
}
