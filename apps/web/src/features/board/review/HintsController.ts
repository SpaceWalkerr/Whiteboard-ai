import { extractGraph, graphFingerprint, type Hint, type HintsResponse } from "@whiteboard/graph";
import type { BoardStore } from "@whiteboard/shared/board";
import { ApiRequestError } from "@/lib/apiClient";

export interface HintsApi {
  fetch(): Promise<HintsResponse>;
}

export interface HintsState {
  enabled: boolean;
  hints: Hint[];
  /** Why hints stopped (hourly limit, plan), shown next to the toggle. */
  notice: string | null;
}

export interface HintsOptions {
  /** Quiet time after my last edit before asking (the spec: ~8 s). */
  delayMs?: number;
  /** Below this many components there is nothing useful to say. */
  minComponents?: number;
  /** After the hourly limit is hit, wait this long before trying again. */
  backoffMs?: number;
}

/**
 * Live AI hints (Pro+) while drawing. Asks the server only when (a) I edited the board myself,
 * (b) I've paused for `delayMs`, and (c) the graph changed in a way that matters to a review
 * (components, labels, connections — not moves or colours). The server skips repeats and
 * caps calls per hour as well; this just avoids asking in the first place.
 */
export class HintsController {
  private state: HintsState = { enabled: false, hints: [], notice: null };
  private readonly listeners = new Set<() => void>();
  private readonly dismissed = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFingerprint: string | null = null;
  private pausedUntil = 0;
  private inFlight = false;
  private readonly delayMs: number;
  private readonly minComponents: number;
  private readonly backoffMs: number;

  constructor(
    private readonly store: BoardStore,
    private readonly api: HintsApi,
    options: HintsOptions = {},
  ) {
    this.delayMs = options.delayMs ?? 8_000;
    this.minComponents = options.minComponents ?? 3;
    this.backoffMs = options.backoffMs ?? 10 * 60_000;
  }

  get = (): HintsState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setEnabled(enabled: boolean): void {
    if (enabled === this.state.enabled) return;
    if (enabled) this.store.doc.on("update", this.onUpdate);
    else {
      this.store.doc.off("update", this.onUpdate);
      this.clearTimer();
    }
    this.set({ enabled, hints: enabled ? this.state.hints : [], notice: null });
  }

  dismiss(id: string): void {
    this.dismissed.add(id);
    this.set({ hints: this.state.hints.filter((h) => h.id !== id) });
  }

  dispose(): void {
    this.setEnabled(false);
    this.listeners.clear();
  }

  private readonly onUpdate = (_update: Uint8Array, origin: unknown): void => {
    // Other people's edits don't trigger my hints (each call uses my hourly allowance).
    if (origin !== this.store.localOrigin) return;
    this.clearTimer();
    this.timer = setTimeout(() => void this.ask(), this.delayMs);
  };

  /** Runs the check now (also used by tests). */
  async ask(now = Date.now()): Promise<void> {
    this.timer = null;
    if (!this.state.enabled || this.inFlight || now < this.pausedUntil) return;
    const graph = extractGraph(this.store.getSnapshot().ordered);
    if (graph.nodes.length < this.minComponents) return;
    const fingerprint = graphFingerprint(graph);
    if (fingerprint === this.lastFingerprint) return;
    this.lastFingerprint = fingerprint;
    this.inFlight = true;
    try {
      const response = await this.api.fetch();
      // Hints may have been switched off while the request was in flight.
      if (!this.get().enabled || response.skipped) return;
      this.set({ hints: response.hints.filter((h) => !this.dismissed.has(h.id)), notice: null });
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 429) {
        this.pausedUntil = now + this.backoffMs;
        this.set({ notice: "Hints are paused for a while (hourly limit reached)." });
      } else if (error instanceof ApiRequestError && error.status === 402) {
        this.setEnabled(false);
        this.set({ notice: error.message });
      } else {
        // Transient failure: try again after the next edit.
        this.lastFingerprint = null;
      }
    } finally {
      this.inFlight = false;
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private set(patch: Partial<HintsState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
