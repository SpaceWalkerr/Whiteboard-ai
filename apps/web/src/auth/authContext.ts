import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { createContext, useContext } from "react";
import type { Profile } from "@whiteboard/shared/api";
import type { ApiClient } from "@/lib/apiClient";

export type AuthStatus = "loading" | "signedOut" | "signedIn";

export interface AuthState {
  status: AuthStatus;
  session: Session | null;
  /** Our profile (after the server bootstrapped the account). */
  profile: Profile | null;
  api: ApiClient;
  supabase: SupabaseClient;
  /** Signs out here; `everywhere` also revokes sessions on all other devices. */
  signOut: (everywhere?: boolean) => Promise<void>;
}

export const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}
