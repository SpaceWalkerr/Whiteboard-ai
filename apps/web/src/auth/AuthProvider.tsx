import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { bootstrapResponseSchema, type Profile } from "@whiteboard/shared/api";
import { AuthContext, type AuthState, type AuthStatus } from "./authContext";
import { createApiClient } from "@/lib/apiClient";
import { clearLocalBoardData } from "./localData";

export function AuthProvider({
  supabase,
  apiUrl,
  children,
}: {
  supabase: SupabaseClient;
  apiUrl: string;
  children: ReactNode;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [profile, setProfile] = useState<Profile | null>(null);
  const queryClient = useQueryClient();

  const api = useMemo(
    () =>
      createApiClient(apiUrl, async () => {
        // getSession refreshes an expired access token first.
        const { data } = await supabase.auth.getSession();
        return data.session?.access_token ?? null;
      }),
    [apiUrl, supabase],
  );

  useEffect(() => {
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setStatus(data.session ? "signedIn" : "signedOut");
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setStatus(next ? "signedIn" : "signedOut");
      if (!next) setProfile(null);
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [supabase]);

  // Once per signed-in user: create profile + workspace, accept pending invites.
  const userId = session?.user.id ?? null;
  useEffect(() => {
    if (userId === null) return;
    let active = true;
    void api
      .request("/me/bootstrap", { method: "POST", body: {}, schema: bootstrapResponseSchema })
      .then((result) => {
        if (!active) return;
        setProfile(result.profile);
        // The dashboard may have loaded before these invites were accepted.
        if (result.acceptedInvites > 0)
          void queryClient.invalidateQueries({ queryKey: ["boards"] });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [userId, api, queryClient]);

  const value = useMemo<AuthState>(
    () => ({
      status,
      session,
      profile,
      api,
      supabase,
      signOut: async (everywhere = false) => {
        await supabase.auth.signOut({ scope: everywhere ? "global" : "local" });
        // Board copies cached for offline use must not outlive the session on this device.
        await clearLocalBoardData();
      },
    }),
    [status, session, profile, api, supabase],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
