import { CloudOff } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SyncState } from "../sync/stores";

function label({ connection, save }: SyncState): string {
  switch (connection) {
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return "Reconnecting…";
    case "offline":
      return "Offline";
    case "connected":
      return save === "saved" ? "Saved" : "Saving…";
  }
}

function dot({ connection, save }: SyncState): string {
  if (connection === "offline") return "bg-destructive";
  if (connection === "connected") return save === "saved" ? "bg-success" : "bg-amber-500";
  return "bg-amber-500 animate-pulse";
}

/** Connection and save indicator. Colour is never the only signal: the text says the same. */
export function ConnectionStatus({ state }: { state: SyncState }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
    >
      <span aria-hidden="true" className={cn("size-2 rounded-full", dot(state))} />
      <span data-sync-status={state.connection} data-save-state={state.save}>
        {label(state)}
      </span>
    </p>
  );
}

/**
 * Shown while edits can't reach the server. Everything is still kept in this browser
 * (IndexedDB) and syncs automatically when the connection returns.
 */
export function OfflineBanner({ state }: { state: SyncState }) {
  const offline = state.connection === "offline";
  const lostWithChanges = state.connection === "reconnecting" && state.save === "saving";
  if (!offline && !lostWithChanges) return null;
  return (
    <div
      role="alert"
      className="absolute top-16 left-1/2 z-30 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 shadow-sm"
    >
      <CloudOff aria-hidden="true" className="size-4 shrink-0" />
      {offline
        ? "You're offline — changes are saved on this device and will sync when you reconnect."
        : "Connection lost — your changes are saved on this device and will sync when it returns."}
    </div>
  );
}
