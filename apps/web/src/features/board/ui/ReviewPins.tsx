import { useMemo, useSyncExternalStore } from "react";
import type { ReviewFinding } from "@whiteboard/graph";
import type { BoardStore } from "@whiteboard/shared/board";
import { cn } from "@/lib/utils";
import { SEVERITY_META } from "../check/severity";
import { pinPlacements } from "../review/pins";
import { worldToScreen } from "../viewport/viewport";
import type { ViewportStore } from "../viewport/viewportStore";

const PIN_SIZE = 22;
const PIN_GAP = 4;

/**
 * Numbered AI-review pins over the canvas (HTML, so they are real buttons: focusable,
 * labelled, crisp at any zoom). The number matches the finding's number in the panel.
 */
export function ReviewPins({
  findings,
  store,
  viewport,
  activeId,
  onSelect,
}: {
  findings: readonly ReviewFinding[];
  store: BoardStore;
  viewport: ViewportStore;
  activeId: string | null;
  onSelect: (finding: ReviewFinding) => void;
}) {
  const vp = useSyncExternalStore(viewport.subscribe, viewport.get);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const placements = useMemo(
    () => pinPlacements(findings, snapshot.shapes),
    [findings, snapshot.shapes],
  );
  const byId = useMemo(() => new Map(findings.map((f) => [f.id, f])), [findings]);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" data-review-pins>
      {placements.map((pin) => {
        const finding = byId.get(pin.findingId);
        if (!finding) return null;
        const meta = SEVERITY_META[pin.severity];
        const p = worldToScreen(vp, pin.anchor);
        const x = p.x - PIN_SIZE / 2 + pin.stackIndex * (PIN_SIZE + PIN_GAP);
        const y = p.y - PIN_SIZE / 2;
        return (
          <button
            key={pin.findingId}
            type="button"
            data-review-pin={pin.number}
            aria-label={`Finding ${String(pin.number)} (${meta.label}): ${finding.title}`}
            aria-pressed={activeId === finding.id}
            title={finding.title}
            onClick={() => {
              onSelect(finding);
            }}
            className={cn(
              "pointer-events-auto absolute top-0 left-0 flex items-center justify-center rounded-full border-2 border-white text-xs font-semibold text-white shadow-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring",
              meta.pinClass,
              activeId === finding.id && "ring-[3px] ring-foreground/60",
            )}
            style={{
              width: PIN_SIZE,
              height: PIN_SIZE,
              transform: `translate(${String(x)}px, ${String(y)}px)`,
            }}
          >
            {pin.number}
          </button>
        );
      })}
    </div>
  );
}
