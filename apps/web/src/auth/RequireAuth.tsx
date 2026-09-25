import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { useAuth } from "./authContext";
import { rememberReturnTo } from "./localData";

export function FullPageMessage({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-svh max-w-md flex-col justify-center gap-4 px-6">
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      {children}
    </main>
  );
}

export function LoadingPage({ label = "Loading…" }: { label?: string }) {
  return (
    <main className="flex min-h-svh items-center justify-center">
      <p role="status" className="text-sm text-muted-foreground">
        {label}
      </p>
    </main>
  );
}

/** Renders children for signed-in users; otherwise sends them to sign in and back here after. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === "loading") return <LoadingPage />;
  if (status === "signedOut") {
    rememberReturnTo(`${location.pathname}${location.search}`);
    return <Navigate to="/sign-in" replace />;
  }
  return children;
}
