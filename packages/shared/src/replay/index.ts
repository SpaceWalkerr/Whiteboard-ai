import * as Y from "yjs";

/** One step of history: the Yjs update(s) stored at time `t` (epoch ms). */
export interface ReplayStep {
  t: number;
  update: Uint8Array;
}

/**
 * Reconstructs a board at any moment of a recorded session from the state before it (`base`)
 * and every update after it, in the order they were stored.
 *
 * The board at time T is `base` plus every step with `t <= T` — exactly what had been
 * committed to the database by then. A full document state is kept every `keyframeEvery`
 * steps, so seeking anywhere costs at most that many updates.
 */
export class ReplayTimeline {
  readonly steps: readonly ReplayStep[];
  /** Epoch ms of the first and last moment worth showing. */
  readonly start: number;
  readonly end: number;
  /** keyframes[k] = state after the first k * keyframeEvery steps. */
  private readonly keyframes: Uint8Array[] = [];

  constructor(
    private readonly base: Uint8Array,
    steps: readonly ReplayStep[],
    range: { start: number; end: number },
    private readonly keyframeEvery = 200,
  ) {
    // Times must never go backwards: with several writers, database clocks can differ by a
    // few ms, and the order that matters is the storage order.
    let last = Number.NEGATIVE_INFINITY;
    this.steps = steps.map((step) => {
      last = Math.max(last, step.t);
      return { t: last, update: step.update };
    });
    this.start = range.start;
    this.end = Math.max(range.end, range.start, last);

    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, base);
      this.keyframes.push(Y.encodeStateAsUpdate(doc));
      this.steps.forEach((step, i) => {
        Y.applyUpdate(doc, step.update);
        if ((i + 1) % keyframeEvery === 0) this.keyframes.push(Y.encodeStateAsUpdate(doc));
      });
    } finally {
      doc.destroy();
    }
  }

  /** How many steps had happened by time `t` (binary search over sorted times). */
  countAt(t: number): number {
    let lo = 0;
    let hi = this.steps.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.steps[mid]?.t ?? Infinity) <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** A new document with the first `count` steps applied. The caller owns (and destroys) it. */
  docAfter(count: number): Y.Doc {
    const n = Math.max(0, Math.min(count, this.steps.length));
    const k = Math.floor(n / this.keyframeEvery);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, this.keyframes[k] ?? this.base);
    this.applySteps(doc, k * this.keyframeEvery, n);
    return doc;
  }

  /** The board as it was at time `t`. The caller owns (and destroys) the document. */
  docAt(t: number): Y.Doc {
    return this.docAfter(this.countAt(t));
  }

  /** Applies steps [from, to) to `doc`, for playing forward without rebuilding. */
  applySteps(doc: Y.Doc, from: number, to: number): void {
    if (to <= from) return;
    doc.transact(() => {
      for (let i = from; i < to; i++) {
        const step = this.steps[i];
        if (step) Y.applyUpdate(doc, step.update);
      }
    });
  }
}

/** Plain shape records of a document (what the board shows), keyed by shape id. */
export function shapeRecords(doc: Y.Doc): Record<string, unknown> {
  return doc.getMap("shapes").toJSON();
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
