import type { ReplayBundle } from "@whiteboard/shared/interview";
import { fromBase64, ReplayTimeline } from "@whiteboard/shared/replay";

/** Builds the timeline from a replay bundle (base state + stored updates). */
export function timelineFromBundle(bundle: ReplayBundle): ReplayTimeline {
  return new ReplayTimeline(
    fromBase64(bundle.base),
    bundle.frames.map((f) => ({ t: f.t, update: fromBase64(f.u) })),
    { start: bundle.startedAt, end: bundle.endedAt },
  );
}
