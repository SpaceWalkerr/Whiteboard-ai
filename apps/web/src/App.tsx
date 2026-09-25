import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import type { WebEnv } from "@whiteboard/shared/env/web";
import { AuthCallbackPage } from "@/auth/AuthCallbackPage";
import { AuthProvider } from "@/auth/AuthProvider";
import { InvitePage, ShareLinkPage } from "@/auth/LinkLandingPages";
import { LoadingPage, RequireAuth } from "@/auth/RequireAuth";
import { SignInPage } from "@/auth/SignInPage";
import { InterviewShareCapture } from "@/features/interview/shareToken";
import { supabaseClient } from "@/lib/supabase";
import { DashboardPage } from "@/pages/DashboardPage";
import { HomePage } from "@/pages/HomePage";
import { NotFoundPage } from "@/pages/NotFoundPage";

// Interview summary and replay (Yjs, react-pdf on demand) load only when opened.
const SummaryPage = lazy(() =>
  import("@/features/interview/SummaryPage").then((m) => ({ default: m.SummaryPage })),
);
const ReplayPage = lazy(() =>
  import("@/features/interview/replay/ReplayPage").then((m) => ({ default: m.ReplayPage })),
);

// The board pulls in Konva and Yjs; load it only when a board is opened.
const BoardRoute = lazy(() =>
  import("@/features/board/BoardRoute").then((m) => ({ default: m.BoardRoute })),
);

export function App({ env }: { env: WebEnv }) {
  const [queryClient] = useState(() => new QueryClient());
  const [supabase] = useState(() => supabaseClient(env));

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider supabase={supabase} apiUrl={env.VITE_API_URL}>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<HomePage apiUrl={env.VITE_API_URL} />} />
            <Route path="/sign-in" element={<SignInPage />} />
            <Route path="/auth/callback" element={<AuthCallbackPage />} />
            <Route
              path="/app"
              element={
                <RequireAuth>
                  <DashboardPage />
                </RequireAuth>
              }
            />
            <Route
              path="/s/:token"
              element={
                <RequireAuth>
                  <ShareLinkPage />
                </RequireAuth>
              }
            />
            <Route
              path="/invite/:token"
              element={
                <RequireAuth>
                  <InvitePage />
                </RequireAuth>
              }
            />
            <Route
              path="/interviews/:interviewId"
              element={
                <InterviewShareCapture>
                  <RequireAuth>
                    <Suspense fallback={<LoadingPage label="Loading the interview…" />}>
                      <SummaryPage />
                    </Suspense>
                  </RequireAuth>
                </InterviewShareCapture>
              }
            />
            <Route
              path="/interviews/:interviewId/replay"
              element={
                <InterviewShareCapture>
                  <RequireAuth>
                    <Suspense fallback={<LoadingPage label="Loading the replay…" />}>
                      <ReplayPage />
                    </Suspense>
                  </RequireAuth>
                </InterviewShareCapture>
              }
            />
            <Route path="/board/local" element={<Navigate to="/app" replace />} />
            <Route
              path="/board/:boardId"
              element={
                <Suspense fallback={<LoadingPage label="Opening board…" />}>
                  <BoardRoute env={env} />
                </Suspense>
              }
            />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
