import type { SyncStatus } from "@whiteboard/shared/sync";
import { cn } from "@/lib/utils";

const LABELS: Record<SyncStatus, string> = {
  connecting: "Connecting…",
  connected: "Live",
  reconnecting: "Reconnecting…",
  offline: "Offline — changes will sync when you reconnect",
};

const DOT: Record<SyncStatus, string> = {
  connecting: "bg-amber-500 animate-pulse",
  connected: "bg-success",
  reconnecting: "bg-amber-500 animate-pulse",
  offline: "bg-destructive",
};

/** Connection indicator. Colour is never the only signal: the text says the same thing. */
export function ConnectionStatus({ status }: { status: SyncStatus }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
    >
      <span aria-hidden="true" className={cn("size-2 rounded-full", DOT[status])} />
      <span data-sync-status={status}>{LABELS[status]}</span>
    </p>
  );
}
