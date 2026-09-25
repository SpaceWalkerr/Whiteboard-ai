import { BoardStore, type Shape } from "@whiteboard/shared/board";
import type { ReplayTimeline } from "@whiteboard/shared/replay";
import { unionRects, type Rect } from "@/features/board/geometry/bounds";
import { boardToSvg } from "@/features/board/export/svg";

export const SPEEDS = [1, 2, 4, 8, 16] as const;
export type Speed = (typeof SPEEDS)[number];

/** With "skip idle", a pause longer than this between edits is fast-forwarded. */
export const IDLE_GAP_MS = 5_000;
/** …landing this long before the next edit, so it is still seen happening. */
const IDLE_LEAD_MS = 500;

export interface PlayerState {
  time: number;
  playing: boolean;
  speed: Speed;
  skipIdle: boolean;
  /** Shapes on the board at `time`, in render order. */
  shapes: readonly Shape[];
}

type ReplayDoc = ReturnType<ReplayTimeline["docAfter"]>;

/**
 * Plays a recorded session: owns the board document at the current time, moving it forward
 * by applying stored updates and rebuilding it (from the nearest keyframe) when seeking back.
 * No DOM here; the UI drives `advance()` from requestAnimationFrame.
 */
export class ReplayPlayer {
  private doc: ReplayDoc;
  private store: BoardStore;
  private applied = 0;
  private state: PlayerState;
  private readonly listeners = new Set<() => void>();

  constructor(readonly timeline: ReplayTimeline) {
    this.doc = timeline.docAfter(0);
    this.store = new BoardStore({ doc: this.doc });
    this.state = {
      time: timeline.start,
      playing: false,
      speed: 4,
      skipIdle: true,
      shapes: this.store.getSnapshot().ordered,
    };
    this.moveTo(timeline.start);
  }

  get = (): PlayerState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  seek(time: number): void {
    this.moveTo(time);
  }

  play(): void {
    // Playing from the end starts over.
    if (this.state.time >= this.timeline.end) this.moveTo(this.timeline.start);
    this.set({ playing: true });
  }

  pause(): void {
    this.set({ playing: false });
  }

  toggle(): void {
    if (this.state.playing) this.pause();
    else this.play();
  }

  setSpeed(speed: Speed): void {
    this.set({ speed });
  }

  setSkipIdle(skipIdle: boolean): void {
    this.set({ skipIdle });
  }

  /** Moves playback forward by `elapsedMs` of wall-clock time. */
  advance(elapsedMs: number): void {
    if (!this.state.playing) return;
    let next = this.state.time + elapsedMs * this.state.speed;
    if (this.state.skipIdle) {
      const upcoming = this.timeline.steps[this.timeline.countAt(this.state.time)];
      if (upcoming && upcoming.t - this.state.time > IDLE_GAP_MS)
        next = Math.max(next, upcoming.t - IDLE_LEAD_MS);
    }
    if (next >= this.timeline.end) {
      this.moveTo(this.timeline.end);
      this.set({ playing: false });
      return;
    }
    this.moveTo(next);
  }

  destroy(): void {
    this.store.destroy();
    this.doc.destroy();
    this.listeners.clear();
  }

  /**
   * One fixed area that fits the board at every moment of the session (sampled), so the
   * picture doesn't jump around as shapes are added and removed.
   */
  sessionFrame(samples = 24): Rect | null {
    const total = this.timeline.steps.length;
    const counts = new Set<number>([0, total]);
    for (let i = 1; i < samples; i++) counts.add(Math.round((total * i) / samples));
    const rects: Rect[] = [];
    for (const count of counts) {
      const doc = this.timeline.docAfter(count);
      const store = new BoardStore({ doc });
      const svg = boardToSvg(store.getSnapshot().ordered, { padding: 48 });
      if (svg) rects.push(svg.bounds);
      store.destroy();
      doc.destroy();
    }
    return unionRects(rects);
  }

  private moveTo(time: number): void {
    const clamped = Math.min(Math.max(time, this.timeline.start), this.timeline.end);
    const count = this.timeline.countAt(clamped);
    if (count >= this.applied) {
      this.timeline.applySteps(this.doc, this.applied, count);
    } else {
      this.store.destroy();
      this.doc.destroy();
      this.doc = this.timeline.docAfter(count);
      this.store = new BoardStore({ doc: this.doc });
    }
    this.applied = count;
    this.set({ time: clamped, shapes: this.store.getSnapshot().ordered });
  }

  private set(patch: Partial<PlayerState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
