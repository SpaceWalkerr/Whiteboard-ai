import { useState, type ReactNode } from "react";
import { useParams } from "react-router";
import { interviewTokenFor, rememberInterviewToken } from "@/auth/localData";

/**
 * Summary links look like /interviews/:id#share=<token>. The fragment is never sent to any
 * server; we keep the token (for signing in first, possibly in a new tab) and remove it
 * from the address bar.
 */
export function captureShareToken(interviewId: string): void {
  const match = /^#share=([\w-]{16,128})$/.exec(window.location.hash);
  if (!match?.[1] || !interviewId) return;
  rememberInterviewToken(interviewId, match[1]);
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
}

/** Wraps the interview routes so a link's token is kept even if the visitor must sign in. */
export function InterviewShareCapture({ children }: { children: ReactNode }) {
  const { interviewId = "" } = useParams();
  // Runs once, during the first render: before a sign-in redirect could drop the fragment.
  useState(() => {
    captureShareToken(interviewId);
    return null;
  });
  return children;
}

export function useInterviewShareToken(interviewId: string): string | undefined {
  const [token] = useState(() => {
    captureShareToken(interviewId);
    return interviewTokenFor(interviewId);
  });
  return token;
}
