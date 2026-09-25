import { useEffect, useState } from "react";
import { remainingMs, type InterviewTimer } from "@whiteboard/shared/interview";

/** Time left on the interview clock, re-rendered a few times a second while it runs. */
export function useCountdown(timer: InterviewTimer | null, serverNow: () => number): number | null {
  const [now, setNow] = useState(serverNow);
  const running = timer !== null && timer.pausedAt === null && timer.endedAt === null;
  useEffect(() => {
    if (!running) return;
    const update = () => {
      setNow(serverNow());
    };
    // Immediately (e.g. just resumed), then a few times a second.
    const first = setTimeout(update, 0);
    const interval = setInterval(update, 250);
    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }, [running, serverNow, timer]);
  // Paused or ended clocks don't depend on `now` (see elapsedMs).
  return timer === null ? null : remainingMs(timer, now);
}
