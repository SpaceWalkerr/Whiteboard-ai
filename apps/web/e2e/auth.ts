import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, type Page } from "@playwright/test";
import { e2eEnv } from "./env";

let admin: SupabaseClient | null = null;

function adminClient(): SupabaseClient {
  if (!e2eEnv.supabaseUrl || !e2eEnv.serviceRoleKey) {
    throw new Error(
      "E2E needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (apps/server/.env locally, secrets in CI).",
    );
  }
  admin ??= createClient(e2eEnv.supabaseUrl, e2eEnv.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return admin;
}

export interface E2EUser {
  id: string;
  email: string;
  name: string;
}

const created: string[] = [];

/** A brand-new, confirmed user in the Supabase project (deleted again by deleteE2EUsers). */
export async function createE2EUser(name: string): Promise<E2EUser> {
  const email = `e2e-${name.toLowerCase().replace(/\W/g, "")}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const { data, error } = await adminClient().auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: name },
  });
  if (error) throw new Error(`createUser failed: ${error.message}`);
  created.push(data.user.id);
  return { id: data.user.id, email, name };
}

/**
 * Signs `page` in with a magic link, "captured in test mode": the admin API mints the link's
 * token instead of emailing it, and the app's /auth/callback completes it exactly like a link
 * clicked in an inbox.
 */
export async function signInWithMagicLink(page: Page, user: E2EUser): Promise<void> {
  const { data, error } = await adminClient().auth.admin.generateLink({
    type: "magiclink",
    email: user.email,
  });
  if (error) throw new Error(`generateLink failed: ${error.message}`);
  await page.goto(
    `/auth/callback?token_hash=${encodeURIComponent(data.properties.hashed_token)}&type=magiclink`,
  );
  await page.waitForURL("**/app");
  await expect(page.getByRole("heading", { name: "Boards", exact: true })).toBeVisible();
}

/**
 * Puts a test user on a plan. The service role bypasses RLS (like apps/server's own access);
 * it is used here only to arrange test data, never by the app.
 */
export async function setPlan(user: E2EUser, plan: "free" | "pro" | "team"): Promise<void> {
  const { error } = await adminClient()
    .from("entitlements")
    .upsert({ user_id: user.id, plan }, { onConflict: "user_id" });
  if (error) throw new Error(`setPlan failed: ${error.message}`);
}

export async function deleteE2EUsers(): Promise<void> {
  for (const id of created.splice(0)) await adminClient().auth.admin.deleteUser(id);
}
