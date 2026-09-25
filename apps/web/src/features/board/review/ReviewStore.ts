import type {
  ReviewRecord,
  ReviewRequest,
  ReviewStage,
  ReviewSummary,
  Severity,
} from "@whiteboard/graph";
import { ApiRequestError } from "@/lib/apiClient";
import { readReviewEvents } from "./sse";

/** This board's review endpoints (a fake in tests). */
export interface ReviewApi {
  stream(request: ReviewRequest, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  list(): Promise<ReviewSummary[]>;
  get(reviewId: string): Promise<ReviewRecord>;
}

/** What the canvas highlights: one finding's shapes. */
export interface ReviewFocus {
  findingId: string;
  shapeIds: readonly string[];
  tone: Severity;
}

export interface ReviewState {
  open: boolean;
  running: boolean;
  stage: ReviewStage | null;
  /** Approximate output tokens written so far (progress only). */
  outputTokens: number;
  error: { code: string; message: string } | null;
  /** Set when the server answered 402: show the upgrade prompt. */
  upgrade: { message: string } | null;
  history: ReviewSummary[] | null;
  /** The review shown in the panel (and pinned on the canvas when completed). */
  current: ReviewRecord | null;
  /** The completed review before `current`, for the comparison. */
  previous: ReviewRecord | null;
  compare: boolean;
  focus: ReviewFocus | null;
  /** Bumped when a review completes, so the quota and screen readers refresh. */
  completions: number;
}

const INITIAL: ReviewState = {
  open: false,
  running: false,
  stage: null,
  outputTokens: 0,
  error: null,
  upgrade: null,
  history: null,
  current: null,
  previous: null,
  compare: false,
  focus: null,
  completions: 0,
};

const GENERIC_ERROR = {
  code: "UNKNOWN",
  message: "The review couldn't be completed. Please try again.",
};

/**
 * The AI design review for one board session: running a review (streamed progress),
 * browsing earlier reviews, comparing with the previous one, and which finding is focused.
 * Framework-free so it can be unit-tested; React subscribes with useSyncExternalStore.
 */
export class ReviewStore {
  private state: ReviewState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private abort: AbortController | null = null;

  constructor(private readonly api: ReviewApi) {}

  get = (): ReviewState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Opens the panel and loads the history (showing the latest completed review). */
  async open(): Promise<void> {
    this.set({ open: true });
    if (this.state.history === null) await this.refreshHistory(true);
  }

  close(): void {
    this.set({ open: false, focus: null });
  }

  dismissUpgrade(): void {
    this.set({ upgrade: null });
  }

  setFocus(focus: ReviewFocus | null): void {
    this.set({ focus });
  }

  setCompare(compare: boolean): void {
    this.set({ compare });
  }

  async select(reviewId: string): Promise<void> {
    if (this.state.running) return;
    try {
      const current = await this.api.get(reviewId);
      this.set({ current, previous: null, focus: null, error: null });
      await this.loadPrevious(current);
    } catch (error) {
      this.set({ error: toError(error) });
    }
  }

  cancel(): void {
    this.abort?.abort();
  }

  async start(request: ReviewRequest): Promise<void> {
    if (this.state.running) return;
    const abort = new AbortController();
    this.abort = abort;
    this.set({
      open: true,
      running: true,
      stage: "preparing",
      outputTokens: 0,
      error: null,
      upgrade: null,
      focus: null,
    });
    let finished = false;
    try {
      const stream = await this.api.stream(request, abort.signal);
      for await (const event of readReviewEvents(stream)) {
        if (event.type === "stage") this.set({ stage: event.stage });
        else if (event.type === "progress") this.set({ outputTokens: event.outputTokens });
        else if (event.type === "error") {
          finished = true;
          this.set({ error: { code: event.code, message: event.message } });
        } else {
          finished = true;
          this.set({
            current: event.review,
            previous: null,
            compare: false,
            completions: this.state.completions + 1,
          });
          await this.refreshHistory(false);
          await this.loadPrevious(event.review);
        }
      }
      if (!finished && !abort.signal.aborted)
        this.set({
          error: { code: "INTERRUPTED", message: "The connection dropped during the review." },
        });
    } catch (error) {
      if (abort.signal.aborted) {
        // Cancelled by the user: nothing to report.
      } else if (error instanceof ApiRequestError && error.status === 402) {
        this.set({ upgrade: { message: error.message } });
      } else {
        this.set({ error: toError(error) });
      }
    } finally {
      this.abort = null;
      this.set({ running: false, stage: null });
    }
  }

  private async refreshHistory(selectLatest: boolean): Promise<void> {
    try {
      const history = await this.api.list();
      this.set({ history });
      const latest = history.find((r) => r.status === "completed");
      if (selectLatest && this.state.current === null && latest) await this.select(latest.id);
    } catch (error) {
      this.set({ error: toError(error) });
    }
  }

  /** The completed review just before `current` (the history is newest first). */
  private async loadPrevious(current: ReviewRecord): Promise<void> {
    const history = this.state.history ?? [];
    const previous = history.find(
      (r) => r.status === "completed" && r.id !== current.id && r.createdAt < current.createdAt,
    );
    if (!previous) return;
    try {
      const record = await this.api.get(previous.id);
      // Only if the user hasn't moved on to another review meanwhile.
      if (this.state.current?.id === current.id) this.set({ previous: record });
    } catch {
      // The comparison is optional; the review itself is shown regardless.
    }
  }

  private set(patch: Partial<ReviewState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

function toError(error: unknown): { code: string; message: string } {
  if (error instanceof ApiRequestError) return { code: error.code, message: error.message };
  return GENERIC_ERROR;
}
