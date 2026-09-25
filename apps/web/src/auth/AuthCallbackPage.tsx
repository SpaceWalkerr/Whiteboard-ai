import type { EmailOtpType, SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useAuth } from "./authContext";
import { FullPageMessage, LoadingPage } from "./RequireAuth";
import { takeReturnTo } from "./localData";

const OTP_TYPES: readonly EmailOtpType[] = [
  "magiclink",
  "email",
  "signup",
  "invite",
  "recovery",
  "email_change",
];

function isOtpType(value: string | null): value is EmailOtpType {
  return value !== null && (OTP_TYPES as readonly string[]).includes(value);
}

// A code/token can only be used once; React StrictMode runs effects twice in development.
const inflight = new Map<string, Promise<string | null>>();

function completeSignIn(supabase: SupabaseClient, url: URL): Promise<string | null> {
  const key = url.search;
  let promise = inflight.get(key);
  if (!promise) {
    promise = (async () => {
      const params = url.searchParams;
      const errorDescription = params.get("error_description");
      if (errorDescription) return errorDescription;
      const code = params.get("code");
      if (code) {
        // OAuth and default magic links (PKCE).
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        return error?.message ?? null;
      }
      const tokenHash = params.get("token_hash");
      const type = params.get("type");
      if (tokenHash && isOtpType(type)) {
        // Email links using {{ .TokenHash }} — work even when opened on another device.
        const { error } = await supabase.auth.verifyOtp({
          token_hash: tokenHash,
          type,
        });
        return error?.message ?? null;
      }
      return "This sign-in link is incomplete. Request a new one.";
    })();
    inflight.set(key, promise);
  }
  return promise;
}

/** /auth/callback — finishes magic-link and OAuth sign-in, then returns to where you were. */
export function AuthCallbackPage() {
  const { supabase } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void completeSignIn(supabase, new URL(window.location.href)).then((message) => {
      if (message) setError(message);
      else void navigate(takeReturnTo(), { replace: true });
    });
  }, [supabase, navigate]);

  if (error) {
    return (
      <FullPageMessage title="Couldn't sign you in">
        <p role="alert" className="text-sm text-muted-foreground">
          {error}
        </p>
        <Link to="/sign-in" className="text-sm font-medium underline">
          Try again
        </Link>
      </FullPageMessage>
    );
  }
  return <LoadingPage label="Signing you in…" />;
}
