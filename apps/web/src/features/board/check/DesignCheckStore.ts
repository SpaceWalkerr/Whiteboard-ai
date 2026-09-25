import { checkDesign, type DesignCheckResult, type Severity } from "@whiteboard/graph";
import type { BoardSnapshot, BoardStore } from "@whiteboard/shared/board";

/** What the canvas highlights: a finding's shapes, or one shape the check didn't include. */
export interface CheckFocus {
  /** Finding id, or `ignored:<shapeId>`. */
  key: string;
  shapeIds: readonly string[];
  tone: Severity;
}

export interface DesignCheckState {
  open: boolean;
  result: DesignCheckResult | null;
  /** The board as it was checked; the result is stale once the board snapshot changes. */
  checkedSnapshot: BoardSnapshot | null;
  /** Bumped on every run, so screen readers re-announce an identical result. */
  runs: number;
  focus: CheckFocus | null;
}

const INITIAL: DesignCheckState = {
  open: false,
  result: null,
  checkedSnapshot: null,
  runs: 0,
  focus: null,
};

/**
 * The rule-based "Check design" for one board session. Runs entirely in the browser on the
 * current snapshot; nothing is written to the board or sent to the server, so viewers can use
 * it too. Runs only when asked: results can go stale, and the panel says so.
 */
export class DesignCheckStore {
  private state: DesignCheckState = INITIAL;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly store: BoardStore) {}

  get = (): DesignCheckState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  run(): DesignCheckResult {
    const snapshot = this.store.getSnapshot();
    const result = checkDesign(snapshot.ordered);
    // Keep the highlight only if what it pointed at is still a problem after re-checking.
    const focus = this.state.focus;
    const stillThere =
      focus !== null &&
      (result.findings.some((finding) => finding.id === focus.key) ||
        result.graph.ignored.some((item) => `ignored:${item.shapeId ?? ""}` === focus.key));
    this.set({
      open: true,
      result,
      checkedSnapshot: snapshot,
      runs: this.state.runs + 1,
      focus: stillThere ? focus : null,
    });
    return result;
  }

  isStale(snapshot: BoardSnapshot): boolean {
    return this.state.checkedSnapshot !== null && this.state.checkedSnapshot !== snapshot;
  }

  setFocus(focus: CheckFocus | null): void {
    this.set({ ...this.state, focus });
  }

  close(): void {
    if (!this.state.open) return;
    this.set({ ...this.state, open: false, focus: null });
  }

  private set(state: DesignCheckState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
