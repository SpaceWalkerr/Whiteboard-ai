import { Sparkles, X } from "lucide-react";
import { useSyncExternalStore } from "react";
import type { Hint } from "@whiteboard/graph";
import type { BoardStore } from "@whiteboard/shared/board";
import { cn } from "@/lib/utils";
import { SEVERITY_META } from "../check/severity";
import type { HintsController } from "../review/HintsController";
import { IconButton } from "./IconButton";

/**
 * Live AI hints (Pro+), bottom centre. Each one can show its shapes or be dismissed; a
 * dismissed hint stays dismissed while it is about the same shapes.
 */
export function HintCards({
  hints: controller,
  store,
  onShow,
}: {
  hints: HintsController;
  store: BoardStore;
  onShow: (hint: Hint) => void;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.get);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  // A hint about shapes that were deleted since is no longer useful.
  const visible = state.enabled
    ? state.hints.filter((h) => h.shapeIds.some((id) => snapshot.shapes.has(id)))
    : [];

  return (
    <section
      aria-label="AI hints"
      aria-live="polite"
      className="pointer-events-none absolute bottom-3 left-1/2 z-20 flex w-[min(28rem,calc(100%-2rem))] -translate-x-1/2 flex-col gap-2"
    >
      {visible.map((hint) => {
        const meta = SEVERITY_META[hint.severity];
        const Icon = meta.icon;
        return (
          <div
            key={hint.id}
            className="pointer-events-auto flex items-start gap-2 rounded-lg border bg-background p-2 pl-3 text-sm shadow-md"
          >
            <Sparkles className="mt-0.5 size-4 shrink-0 text-violet-700" aria-hidden="true" />
            <div className="flex flex-1 flex-col gap-1">
              <span
                className={cn(
                  "inline-flex w-fit items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium",
                  meta.badgeClass,
                )}
              >
                <Icon className="size-3.5" aria-hidden="true" />
                {`Hint · ${meta.label}`}
              </span>
              <p>{hint.text}</p>
              <button
                type="button"
                className="w-fit rounded-sm text-xs font-medium underline underline-offset-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                onClick={() => {
                  onShow(hint);
                }}
              >
                Show on board
              </button>
            </div>
            <IconButton
              label="Dismiss hint"
              onClick={() => {
                controller.dismiss(hint.id);
              }}
            >
              <X />
            </IconButton>
          </div>
        );
      })}
    </section>
  );
}
