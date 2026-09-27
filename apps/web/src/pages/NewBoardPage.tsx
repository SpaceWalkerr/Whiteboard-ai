import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { boardDetailSchema } from "@whiteboard/shared/api";
import { limitCodeSchema } from "@whiteboard/shared/billing";
import type { LimitCode } from "@whiteboard/shared/entitlements";
import { FullPageMessage, LoadingPage } from "@/auth/RequireAuth";
import { useAuth } from "@/auth/authContext";
import { UpgradeDialog } from "@/features/board/ui/UpgradeDialog";
import { ApiRequestError } from "@/lib/apiClient";

/**
 * /app/new?template=<slug> — where "Use this template" lands (after sign-in if needed).
 * Creates the board once and opens it; plan limits show the upgrade prompt.
 */
export function NewBoardPage() {
  const { api } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const templateId = params.get("template") ?? undefined;
  const [error, setError] = useState<string | null>(null);
  const [upgrade, setUpgrade] = useState<{ message: string; code: LimitCode } | null>(null);
  // Effects run twice in development (StrictMode); a board must be created only once.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api
      .request("/boards", {
        method: "POST",
        body: templateId ? { templateId } : {},
        schema: boardDetailSchema,
      })
      .then((board) => navigate(`/board/${board.id}`, { replace: true }))
      .catch((caught: unknown) => {
        if (caught instanceof ApiRequestError && caught.status === 402) {
          const code = limitCodeSchema.safeParse(caught.code);
          setUpgrade({
            message: caught.message,
            code: code.success ? code.data : "PLAN_REQUIRED",
          });
        } else {
          setError(caught instanceof Error ? caught.message : "Couldn't create the board.");
        }
      });
  }, [api, navigate, templateId]);

  if (upgrade) {
    return (
      <>
        <FullPageMessage title="You've reached your plan's limit">
          <p className="text-sm text-muted-foreground">{upgrade.message}</p>
          <Link to="/app" className="text-sm font-medium underline">
            Back to your boards
          </Link>
        </FullPageMessage>
        <UpgradeDialog
          message={upgrade.message}
          code={upgrade.code}
          onOpenChange={(open) => {
            if (!open) void navigate("/app", { replace: true });
          }}
        />
      </>
    );
  }
  if (error) {
    return (
      <FullPageMessage title="Couldn't create the board">
        <p role="alert" className="text-sm text-muted-foreground">
          {error}
        </p>
        <Link to="/app" className="text-sm font-medium underline">
          Back to your boards
        </Link>
      </FullPageMessage>
    );
  }
  return <LoadingPage label="Creating your board…" />;
}
