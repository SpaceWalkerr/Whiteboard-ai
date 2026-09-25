import * as Y from "yjs";
import type { BoardStore } from "./store";

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * Per-user undo/redo. Only changes made through this client's store (its local origin) are
 * tracked, so from Phase 2 on, undo never reverts a collaborator's edits.
 */
export class BoardHistory {
  private readonly manager: Y.UndoManager;
  private readonly listeners = new Set<() => void>();
  private state: HistoryState = { canUndo: false, canRedo: false };
  private savedCaptureTimeout: number | null = null;

  constructor(store: BoardStore, options: { captureTimeout?: number } = {}) {
    this.manager = new Y.UndoManager(store.yShapesMap, {
      trackedOrigins: new Set([store.localOrigin]),
      // Rapid consecutive edits (typing, nudging) merge into one step.
      captureTimeout: options.captureTimeout ?? 500,
    });
    const update = () => {
      const next = { canUndo: this.manager.canUndo(), canRedo: this.manager.canRedo() };
      if (next.canUndo === this.state.canUndo && next.canRedo === this.state.canRedo) return;
      this.state = next;
      for (const listener of this.listeners) listener();
    };
    this.manager.on("stack-item-added", update);
    this.manager.on("stack-item-popped", update);
    this.manager.on("stack-cleared", update);
  }

  getState = (): HistoryState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  undo(): void {
    this.endStep();
    this.manager.stopCapturing();
    this.manager.undo();
  }

  redo(): void {
    this.manager.redo();
  }

  /**
   * Starts a new undo step. Call at gesture boundaries so a whole drag or resize (many
   * updates) undoes as one step, and the next action never merges into it.
   */
  stopCapturing(): void {
    this.manager.stopCapturing();
  }

  /**
   * Opens a step that lasts until `endStep`, however long the gesture takes (a slow drag with
   * pauses must still undo in one go). Steps do not nest; a second begin is ignored.
   */
  beginStep(): void {
    if (this.savedCaptureTimeout !== null) return;
    this.manager.stopCapturing();
    this.savedCaptureTimeout = this.manager.captureTimeout;
    this.manager.captureTimeout = Number.POSITIVE_INFINITY;
  }

  endStep(): void {
    if (this.savedCaptureTimeout === null) return;
    this.manager.captureTimeout = this.savedCaptureTimeout;
    this.savedCaptureTimeout = null;
    this.manager.stopCapturing();
  }

  /** Runs `fn` as exactly one undo step. */
  runAsSingleStep(fn: () => void): void {
    this.beginStep();
    try {
      fn();
    } finally {
      this.endStep();
    }
  }

  destroy(): void {
    this.manager.destroy();
    this.listeners.clear();
  }
}
