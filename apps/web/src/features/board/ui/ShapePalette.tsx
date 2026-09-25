import { useSyncExternalStore } from "react";
import { SYSTEM_SHAPE_TYPES } from "@whiteboard/shared/board";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { BoardController } from "../controller";
import { SYSTEM_SHAPE_META } from "../model/systemShapes";
import { NodeIcon } from "./NodeIcon";

/** System-design shapes. Pick one, then click (or drag) on the canvas to place it. */
export function ShapePalette({ controller }: { controller: BoardController }) {
  const ui = useSyncExternalStore(controller.subscribeUi, controller.getUi);
  return (
    <nav
      aria-label="System design shapes"
      className="absolute top-1/2 left-3 z-20 grid -translate-y-1/2 grid-cols-2 gap-1 rounded-lg border bg-background p-1.5 shadow-sm"
    >
      {SYSTEM_SHAPE_TYPES.map((type) => {
        const meta = SYSTEM_SHAPE_META[type];
        const active = ui.tool === type;
        return (
          <Tooltip key={type}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={meta.label}
                aria-pressed={active}
                onClick={() => {
                  controller.setTool(active ? "select" : type);
                }}
                className={cn(
                  "flex size-10 items-center justify-center rounded-md outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  active && "bg-primary text-primary-foreground hover:bg-primary/90",
                )}
              >
                <NodeIcon icon={meta.icon} className="size-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {meta.label} — click the canvas to place, or press / to insert by name
            </TooltipContent>
          </Tooltip>
        );
      })}
    </nav>
  );
}
