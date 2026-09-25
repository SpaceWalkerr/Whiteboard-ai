import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { acceptedInviteSchema, resolvedShareLinkSchema } from "@whiteboard/shared/api";
import { Button } from "@/components/ui/button";
import { ApiRequestError } from "@/lib/apiClient";
import { useAuth } from "./authContext";
import { FullPageMessage, LoadingPage } from "./RequireAuth";
import { rememberShareToken } from "./localData";

/** /s/:token — opens the board a share link points to (the token stays out of later URLs). */
export function ShareLinkPage() {
  const { token = "" } = useParams();
  const { api } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .request("/share-links/resolve", {
        method: "POST",
        body: { token },
        schema: resolvedShareLinkSchema,
      })
      .then(({ boardId }) => {
        rememberShareToken(boardId, token);
        void navigate(`/board/${boardId}`, { replace: true });
      })
      .catch((e: unknown) => {
        setError(e instanceof ApiRequestError ? e.message : "Something went wrong.");
      });
  }, [api, token, navigate]);

  if (error) {
    return (
      <FullPageMessage title="This link doesn't work">
        <p className="text-sm text-muted-foreground">{error}</p>
        <Link to="/app" className="text-sm font-medium underline">
          Go to your boards
        </Link>
      </FullPageMessage>
    );
  }
  return <LoadingPage label="Opening board…" />;
}

/** /invite/:token — accepts an email invite (the signed-in email must match). */
export function InvitePage() {
  const { token = "" } = useParams();
  const { api, signOut, session } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .request("/invites/accept", { method: "POST", body: { token }, schema: acceptedInviteSchema })
      .then(({ boardId }) => {
        void navigate(`/board/${boardId}`, { replace: true });
      })
      .catch((e: unknown) => {
        setError(e instanceof ApiRequestError ? e.message : "Something went wrong.");
      });
  }, [api, token, navigate]);

  if (error) {
    return (
      <FullPageMessage title="Couldn't accept the invite">
        <p className="text-sm text-muted-foreground">{error}</p>
        <p className="text-sm text-muted-foreground">You're signed in as {session?.user.email}.</p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void signOut()}>
            Sign in with another account
          </Button>
          <Button asChild variant="ghost">
            <Link to="/app">Go to your boards</Link>
          </Button>
        </div>
      </FullPageMessage>
    );
  }
  return <LoadingPage label="Accepting invite…" />;
}
