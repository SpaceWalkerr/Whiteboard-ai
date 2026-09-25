import type { Awareness } from "y-protocols/awareness";
import {
  presenceSchema,
  type DeniedReason,
  type Presence,
  type SaveState,
  type SyncStatus,
} from "@whiteboard/shared/sync";

export interface SyncState {
  connection: SyncStatus;
  /** "saved" once the server confirmed every edit in this browser is in its database. */
  save: SaveState;
  /** Why the server refused us (when connection is "denied"). */
  denied: DeniedReason | null;
}

/** Connection + save status as an external store (the provider lives in an effect). */
export class StatusStore {
  private state: SyncState = { connection: "connecting", save: "saved", denied: null };
  private readonly listeners = new Set<() => void>();

  get = (): SyncState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(next: SyncState): void {
    if (
      next.connection === this.state.connection &&
      next.save === this.state.save &&
      next.denied === this.state.denied
    ) {
      return;
    }
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

export interface Peer {
  clientId: number;
  presence: Presence;
}

/** Everyone else in the room, from awareness. Re-validated here: awareness is network input. */
export class PeersStore {
  private peers: readonly Peer[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly awareness: Awareness) {
    awareness.on("change", this.refresh);
  }

  get = (): readonly Peer[] => this.peers;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private readonly refresh = (): void => {
    const next: Peer[] = [];
    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.awareness.clientID) continue;
      const parsed = presenceSchema.safeParse(state);
      if (parsed.success) next.push({ clientId, presence: parsed.data });
    }
    next.sort((a, b) => a.clientId - b.clientId);
    this.peers = next;
    for (const listener of this.listeners) listener();
  };
}

/** Calls `fn` at most every `ms`, always delivering the latest value. */
export function throttle<T>(fn: (value: T) => void, ms: number): (value: T) => void {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: T;
  return (value: T) => {
    latest = value;
    const wait = last + ms - Date.now();
    if (wait <= 0) {
      last = Date.now();
      fn(value);
      return;
    }
    timer ??= setTimeout(() => {
      timer = null;
      last = Date.now();
      fn(latest);
    }, wait);
  };
}
