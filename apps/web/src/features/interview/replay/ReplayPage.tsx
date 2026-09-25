import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import type { ReplayBundle } from "@whiteboard/shared/interview";
import { useAuth } from "@/auth/authContext";
import { FullPageMessage, LoadingPage } from "@/auth/RequireAuth";
import { ApiRequestError } from "@/lib/apiClient";
import { interviewApi } from "../api";
import { useInterviewShareToken } from "../shareToken";
import { timelineFromBundle } from "./bundle";
import { ReplayPlayer } from "./ReplayPlayer";
import { ReplayView } from "./ReplayView";

/** /interviews/:id/replay — the session, reconstructed from the board's stored history. */
export function ReplayPage() {
  const { interviewId = "" } = useParams();
  const { api: client } = useAuth();
  const [api] = useState(() => interviewApi(client));
  const shareToken = useInterviewShareToken(interviewId);
  const bundle = useQuery({
    queryKey: ["interview-replay", interviewId],
    queryFn: () => api.replay(interviewId, shareToken),
    retry: false,
    staleTime: Infinity,
  });
  const summary = useQuery({
    queryKey: ["interview-summary", interviewId],
    queryFn: () => api.summary(interviewId, shareToken),
    retry: false,
  });

  if (bundle.isPending) return <LoadingPage label="Loading the replay…" />;
  if (bundle.isError) {
    const status = bundle.error instanceof ApiRequestError ? bundle.error.status : 0;
    return (
      <FullPageMessage
        title={status === 403 || status === 404 ? "No access" : "Something went wrong"}
      >
        {status === 403 || status === 404
          ? "This replay isn't available to you."
          : bundle.error.message}
      </FullPageMessage>
    );
  }
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-6 sm:px-6">
      <Link
        to={`/interviews/${interviewId}`}
        className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground focus-visible:underline"
      >
        <ArrowLeft className="size-4" aria-hidden="true" /> Interview summary
      </Link>
      <h1 className="text-2xl font-bold tracking-tight">
        {summary.data ? `Replay: ${summary.data.question.title}` : "Replay"}
      </h1>
      <Player bundle={bundle.data} />
    </main>
  );
}

function Player({ bundle }: { bundle: ReplayBundle }) {
  // No teardown in an effect: the player holds no external listeners, so it is simply
  // garbage-collected (destroying it in a cleanup would break StrictMode's dev remount).
  const player = useMemo(() => new ReplayPlayer(timelineFromBundle(bundle)), [bundle]);
  return <ReplayView player={player} markers={bundle.markers} />;
}
