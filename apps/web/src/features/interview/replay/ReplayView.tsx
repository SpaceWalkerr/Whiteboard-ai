import { Pause, Play } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReplayMarker } from "@whiteboard/shared/interview";
import { Button } from "@/components/ui/button";
import { canvasMeasure } from "@/features/board/export/download";
import { boardToSvg } from "@/features/board/export/svg";
import { cn } from "@/lib/utils";
import { sessionClock } from "./clock";
import { SPEEDS, type ReplayPlayer, type Speed } from "./ReplayPlayer";

const MARKER_COLOR: Record<ReplayMarker["kind"], string> = {
  started: "bg-slate-600",
  ended: "bg-slate-600",
  hint_revealed: "bg-amber-500",
  timer_paused: "bg-slate-400",
  timer_resumed: "bg-slate-400",
  timer_extended: "bg-slate-400",
  review_started: "bg-violet-600",
  review_completed: "bg-violet-600",
  note: "bg-sky-600",
};

/**
 * The board over time: a picture of the board at the scrubber's time, play/pause, speed,
 * skip-idle, and markers for AI reviews, hints, timer changes and (for interviewers) notes.
 * Keyboard: the scrubber is a native range input (arrows, Page Up/Down, Home/End); Space
 * toggles playback anywhere in the player.
 */
export function ReplayView({ player, markers }: { player: ReplayPlayer; markers: ReplayMarker[] }) {
  const state = useSyncExternalStore(player.subscribe, player.get);
  const { timeline } = player;
  const duration = Math.max(1, timeline.end - timeline.start);
  const frame = useMemo(() => player.sessionFrame(), [player]);
  const [measure] = useState(canvasMeasure);
  const sliderId = useId();
  const speedId = useId();
  const skipId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  // Drive playback from animation frames while playing.
  useEffect(() => {
    if (!state.playing) return;
    let last = performance.now();
    let handle = requestAnimationFrame(function tick(now) {
      player.advance(now - last);
      last = now;
      handle = requestAnimationFrame(tick);
    });
    return () => {
      cancelAnimationFrame(handle);
    };
  }, [player, state.playing]);

  const image = useMemo(() => {
    if (!frame) return null;
    const svg = boardToSvg(state.shapes, { frame, measure });
    return svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.svg)}` : null;
  }, [state.shapes, frame, measure]);

  // Space plays/pauses from anywhere in the player (buttons and selects keep their own).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== " ") return;
      const target = event.target;
      if (target instanceof HTMLButtonElement || target instanceof HTMLSelectElement) return;
      if (target instanceof HTMLInputElement && target.type === "checkbox") return;
      event.preventDefault();
      player.toggle();
    };
    root.addEventListener("keydown", onKeyDown);
    return () => {
      root.removeEventListener("keydown", onKeyDown);
    };
  }, [player]);

  const elapsed = state.time - timeline.start;
  const recent = markers.filter((m) => m.at <= state.time).at(-1);

  return (
    <div ref={rootRef} role="region" aria-label="Replay player" className="flex flex-col gap-3">
      <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-lg border bg-white">
        {image ? (
          <img
            src={image}
            alt={`The board ${sessionClock(elapsed)} into the session, ${String(state.shapes.length)} shapes`}
            className="size-full object-contain"
          />
        ) : (
          <p className="text-sm text-muted-foreground">Nothing was drawn in this session.</p>
        )}
        {recent && (
          <span className="absolute bottom-2 left-2 max-w-[80%] truncate rounded-md bg-background/90 px-2 py-1 text-xs shadow-sm">
            {`${sessionClock(recent.at - timeline.start)} — ${recent.label}`}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={sliderId} className="sr-only">
          Session time
        </label>
        <div className="relative">
          <input
            id={sliderId}
            type="range"
            min={0}
            max={duration}
            step={1000}
            value={Math.round(elapsed)}
            aria-valuetext={`${sessionClock(elapsed)} of ${sessionClock(duration)}`}
            onChange={(e) => {
              player.seek(timeline.start + Number(e.target.value));
            }}
            className="w-full accent-violet-700"
          />
        </div>
        <ol aria-label="Moments in the session" className="relative h-5">
          {markers.map((marker, i) => {
            const left = ((marker.at - timeline.start) / duration) * 100;
            return (
              <li
                key={`${marker.kind}-${String(marker.at)}-${String(i)}`}
                className="absolute top-0 -translate-x-1/2"
                style={{ left: `${String(Math.min(100, Math.max(0, left)))}%` }}
              >
                <button
                  type="button"
                  title={`${sessionClock(marker.at - timeline.start)} — ${marker.label}`}
                  aria-label={`Jump to ${sessionClock(marker.at - timeline.start)}: ${marker.label}`}
                  onClick={() => {
                    player.seek(marker.at);
                  }}
                  className={cn(
                    "block size-3 rounded-full ring-2 ring-white outline-none focus-visible:ring-[3px] focus-visible:ring-ring",
                    MARKER_COLOR[marker.kind],
                  )}
                />
              </li>
            );
          })}
        </ol>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Button
          size="sm"
          onClick={() => {
            player.toggle();
          }}
          aria-label={state.playing ? "Pause replay" : "Play replay"}
        >
          {state.playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          {state.playing ? "Pause" : "Play"}
        </Button>
        <span className="font-mono tabular-nums" aria-live="off">
          {`${sessionClock(elapsed)} / ${sessionClock(duration)}`}
        </span>
        <label htmlFor={speedId} className="ml-auto">
          Speed
        </label>
        <select
          id={speedId}
          value={state.speed}
          onChange={(e) => {
            player.setSpeed(Number(e.target.value) as Speed);
          }}
          className="h-8 rounded-md border bg-transparent px-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {SPEEDS.map((speed) => (
            <option key={speed} value={speed}>{`${String(speed)}×`}</option>
          ))}
        </select>
        <label htmlFor={skipId} className="flex items-center gap-1.5">
          <input
            id={skipId}
            type="checkbox"
            checked={state.skipIdle}
            onChange={(e) => {
              player.setSkipIdle(e.target.checked);
            }}
          />
          Skip idle time
        </label>
      </div>

      {markers.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">{`All moments (${String(markers.length)})`}</summary>
          <ul className="mt-2 flex flex-col gap-1">
            {markers.map((marker, i) => (
              <li key={`${marker.kind}-${String(marker.at)}-${String(i)}-list`}>
                <button
                  type="button"
                  className="text-left underline-offset-2 hover:underline focus-visible:underline"
                  onClick={() => {
                    player.seek(marker.at);
                  }}
                >
                  <span className="font-mono tabular-nums">
                    {sessionClock(marker.at - timeline.start)}
                  </span>
                  {` ${marker.label}`}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
