import { useId, useState } from "react";
import { Link, Navigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "./authContext";
import { takeReturnTo } from "./localData";

type Provider = "google" | "github";

export function SignInPage() {
  const { status, supabase } = useAuth();
  const emailId = useId();
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const redirectTo = `${window.location.origin}/auth/callback`;

  if (status === "signedIn") return <Navigate to={takeReturnTo()} replace />;

  const sendLink = async () => {
    setBusy(true);
    setError(null);
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    });
    setBusy(false);
    if (otpError) setError(otpError.message);
    else setSentTo(email);
  };

  const oauth = async (provider: Provider) => {
    setError(null);
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo },
    });
    if (oauthError) setError(oauthError.message);
  };

  return (
    <main className="mx-auto flex min-h-svh max-w-sm flex-col justify-center gap-6 px-6">
      <div className="space-y-2">
        <Link to="/" className="text-sm text-muted-foreground hover:underline">
          ← Whiteboard.ai
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">Sign in</h1>
        <p className="text-sm text-muted-foreground">New here? Signing in creates your account.</p>
      </div>

      {sentTo ? (
        <div role="status" className="rounded-lg border bg-muted/50 p-4 text-sm">
          Check <strong>{sentTo}</strong> for a sign-in link. You can close this tab.
        </div>
      ) : (
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void sendLink();
          }}
        >
          <label htmlFor={emailId} className="text-sm font-medium">
            Email
          </label>
          <Input
            id={emailId}
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
          />
          <Button type="submit" disabled={busy || email.length === 0}>
            {busy ? "Sending…" : "Email me a sign-in link"}
          </Button>
        </form>
      )}

      <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
        <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
      </div>
      <div className="grid gap-2">
        <Button variant="outline" onClick={() => void oauth("google")}>
          Continue with Google
        </Button>
        <Button variant="outline" onClick={() => void oauth("github")}>
          Continue with GitHub
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </main>
  );
}
