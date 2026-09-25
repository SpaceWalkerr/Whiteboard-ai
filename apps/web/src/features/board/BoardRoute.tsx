import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { Link, Navigate, useLocation, useParams } from "react-router";
import { boardDetailSchema, ticketResponseSchema } from "@whiteboard/shared/api";
import type { WebEnv } from "@whiteboard/shared/env/web";
import { boardIdSchema } from "@whiteboard/shared/sync";
import { useAuth } from "@/auth/authContext";
import { FullPageMessage, LoadingPage } from "@/auth/RequireAuth";
import {
  cachedBoardDetail,
  rememberBoardDetail,
  rememberReturnTo,
  shareTokenFor,
} from "@/auth/localData";
import { profileFromSession } from "@/auth/sessionProfile";
import { ApiRequestError } from "@/lib/apiClient";
import { NotFoundPage } from "@/pages/NotFoundPage";
import { BoardPage, type TicketFetchResult } from "./BoardPage";
import { presenceUserFor } from "./sync/identity";

/**
 * /board/:boardId — loads the board (with any share-link token from this session) and works out
 * access before the editor mounts. Public boards open without signing in; everything else asks
 * the visitor to sign in and brings them back. Offline, a previously opened board opens from its
 * cached details and IndexedDB copy; the server re-checks access when the connection returns.
 */
export function BoardRoute({ env }: { env: WebEnv }) {
  const { boardId = "" } = useParams();
  const valid = boardIdSchema.safeParse(boardId).success;
  const { status, api, profile, session } = useAuth();
  const location = useLocation();
  const queryClient = useQueryClient();
  const shareToken = shareTokenFor(boardId);
  const [guestId] = useState(() => `guest-${crypto.randomUUID()}`);

  const detail = useQuery({
    queryKey: ["board", boardId, status],
    queryFn: async () => {
      try {
        const fresh = await api.request(`/boards/${boardId}`, {
          schema: boardDetailSchema,
          shareToken,
        });
        rememberBoardDetail(fresh);
        return fresh;
      } catch (error) {
        const offline = error instanceof ApiRequestError && error.status === 0;
        const cached = offline ? cachedBoardDetail(boardId) : null;
        if (cached) return cached;
        throw error;
      }
    },
    enabled: valid && status !== "loading",
    // Run (and fail fast) even while offline, so the cached fallback can kick in.
    networkMode: "always",
    retry: false,
  });

  const fetchTicket = useCallback(async (): Promise<TicketFetchResult> => {
    try {
      const ticket = await api.request(`/boards/${boardId}/ticket`, {
        method: "POST",
        body: shareToken ? { shareToken } : {},
        schema: ticketResponseSchema,
      });
      return { ok: true, ticket: ticket.ticket, role: ticket.role };
    } catch (error) {
      if (error instanceof ApiRequestError) {
        if (error.status === 401) return { ok: false, reason: "unauthorized" };
        if (error.status === 403) return { ok: false, reason: "forbidden" };
        if (error.status === 404) return { ok: false, reason: "not_found" };
      }
      return { ok: false, reason: "error" };
    }
  }, [api, boardId, shareToken]);

  const renameBoard = useCallback(
    async (title: string) => {
      await api.request(`/boards/${boardId}`, {
        method: "PATCH",
        body: { title },
        schema: boardDetailSchema,
        shareToken,
      });
      await queryClient.invalidateQueries({ queryKey: ["boards"] });
    },
    [api, boardId, shareToken, queryClient],
  );

  if (!valid) return <NotFoundPage />;
  if (status === "loading" || detail.isPending) return <LoadingPage label="Opening board…" />;
  if (detail.isError) {
    const code = detail.error instanceof ApiRequestError ? detail.error.status : -1;
    if (code === 401) {
      rememberReturnTo(`${location.pathname}${location.search}`);
      return <Navigate to="/sign-in" replace />;
    }
    if (code === 403) {
      return (
        <FullPageMessage title="You don't have access to this board">
          <p className="text-sm text-muted-foreground">
            Ask the owner to invite you or send you a share link.
          </p>
          <Link to="/app" className="text-sm font-medium underline">
            Go to your boards
          </Link>
        </FullPageMessage>
      );
    }
    if (code === 404) return <NotFoundPage />;
    return (
      <FullPageMessage title="Couldn't open the board">
        <p className="text-sm text-muted-foreground">{detail.error.message}</p>
      </FullPageMessage>
    );
  }

  const me = presenceUserFor(
    status === "signedIn" ? (profile ?? profileFromSession(session)) : null,
    guestId,
  );
  return (
    <BoardPage
      key={boardId}
      boardId={boardId}
      serverUrl={env.VITE_WS_URL}
      debugTools={env.VITE_DEBUG_TOOLS}
      detail={detail.data}
      me={me}
      fetchTicket={fetchTicket}
      onTitleChange={renameBoard}
    />
  );
}
