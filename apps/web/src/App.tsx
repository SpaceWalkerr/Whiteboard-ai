import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useMemo } from "react";
import { Navigate, Route, Routes } from "react-router";
import type { WebEnv } from "@whiteboard/shared/env/web";
import { AuthCallbackPage } from "@/auth/AuthCallbackPage";
import { AuthProvider } from "@/auth/AuthProvider";
import { InvitePage, ShareLinkPage } from "@/auth/LinkLandingPages";
import { LoadingPage, RequireAuth } from "@/auth/RequireAuth";
import { SignInPage } from "@/auth/SignInPage";
import { InterviewShareCapture } from "@/features/interview/shareToken";
import { NotFoundPage } from "@/pages/NotFoundPage";
import { CookieBanner } from "@/site/consent/CookieBanner";
import { SiteLayout } from "@/site/layout/SiteLayout";
import { PUBLIC_ROUTES } from "./routes";

// App pages (Yjs, Konva, react-pdf on demand) load only when opened.
const DashboardPage = lazy(() =>
  import("@/pages/DashboardPage").then((m) => ({ default: m.DashboardPage })),
);
const NewBoardPage = lazy(() =>
  import("@/pages/NewBoardPage").then((m) => ({ default: m.NewBoardPage })),
);
const SummaryPage = lazy(() =>
  import("@/features/interview/SummaryPage").then((m) => ({ default: m.SummaryPage })),
);
const ReplayPage = lazy(() =>
  import("@/features/interview/replay/ReplayPage").then((m) => ({ default: m.ReplayPage })),
);
const BillingSettingsPage = lazy(() =>
  import("@/features/billing/BillingSettingsPage").then((m) => ({
    default: m.BillingSettingsPage,
  })),
);
const BoardRoute = lazy(() =>
  import("@/features/board/BoardRoute").then((m) => ({ default: m.BoardRoute })),
);

/**
 * The whole app. The router is supplied by the caller: BrowserRouter in the browser
 * (main.tsx), StaticRouter when prerendering public pages (site/entry-server.tsx).
 */
export function App({ env, queryClient }: { env: WebEnv; queryClient: QueryClient }) {
  const loadSupabase = useCallback(
    () => import("@/lib/supabase").then((m) => m.supabaseClient(env)),
    [env],
  );
  const analytics = useMemo(
    () => ({ key: env.VITE_POSTHOG_KEY, host: env.VITE_POSTHOG_HOST }),
    [env.VITE_POSTHOG_KEY, env.VITE_POSTHOG_HOST],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider loadSupabase={loadSupabase} apiUrl={env.VITE_API_URL}>
        <Routes>
          <Route element={<SiteLayout />}>
            {PUBLIC_ROUTES.map(({ path, Page }) => (
              <Route key={path} path={path} element={<Page />} />
            ))}
          </Route>
          <Route path="/sign-in" element={<SignInPage />} />
          <Route
            path="/app/settings/billing"
            element={
              <RequireAuth>
                <Suspense fallback={<LoadingPage label="Loading billing…" />}>
                  <BillingSettingsPage />
                </Suspense>
              </RequireAuth>
            }
          />
          <Route path="/auth/callback" element={<AuthCallbackPage />} />
          <Route
            path="/app"
            element={
              <RequireAuth>
                <Suspense fallback={<LoadingPage />}>
                  <DashboardPage />
                </Suspense>
              </RequireAuth>
            }
          />
          <Route
            path="/app/new"
            element={
              <RequireAuth>
                <Suspense fallback={<LoadingPage label="Creating your board…" />}>
                  <NewBoardPage />
                </Suspense>
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
        <CookieBanner analytics={analytics} />
      </AuthProvider>
    </QueryClientProvider>
  );
}
