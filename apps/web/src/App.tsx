import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router";
import { boardIdSchema } from "@whiteboard/shared/sync";
import type { WebEnv } from "@whiteboard/shared/env/web";
import { HomePage } from "@/pages/HomePage";
import { NotFoundPage } from "@/pages/NotFoundPage";

// The board pulls in Konva and Yjs; load it only when a board is opened.
const BoardPage = lazy(() =>
  import("@/features/board/BoardPage").then((m) => ({ default: m.BoardPage })),
);

/** Unguessable id: until Phase 4 adds permissions, knowing the link is what grants access. */
function newBoardId(): string {
  return crypto.randomUUID();
}

function BoardRoute({ env }: { env: WebEnv }) {
  const { boardId = "" } = useParams();
  if (!boardIdSchema.safeParse(boardId).success) return <NotFoundPage />;
  return (
    <Suspense fallback={<p className="p-6 text-sm text-muted-foreground">Loading board…</p>}>
      {/* Keyed so switching boards starts a fresh session. */}
      <BoardPage
        key={boardId}
        boardId={boardId}
        serverUrl={env.VITE_WS_URL}
        debugTools={env.VITE_DEBUG_TOOLS}
      />
    </Suspense>
  );
}

export function App({ env }: { env: WebEnv }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<HomePage apiUrl={env.VITE_API_URL} />} />
          {/* The Phase 1 local board is now just "a new board". */}
          <Route path="/board/local" element={<Navigate to={`/board/${newBoardId()}`} replace />} />
          <Route path="/board/:boardId" element={<BoardRoute env={env} />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
