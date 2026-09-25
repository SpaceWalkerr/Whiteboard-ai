import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { WebEnv } from "@whiteboard/shared/env/web";

let client: SupabaseClient | null = null;

/**
 * The Supabase client, used ONLY for authentication (sign-in, session refresh, sign-out).
 * All data goes through apps/server; RLS keeps our tables closed to this public key.
 */
export function supabaseClient(env: WebEnv): SupabaseClient {
  client ??= createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      flowType: "pkce",
      persistSession: true,
      autoRefreshToken: true,
      // /auth/callback handles the URL explicitly (code or token_hash).
      detectSessionInUrl: false,
    },
  });
  return client;
}
