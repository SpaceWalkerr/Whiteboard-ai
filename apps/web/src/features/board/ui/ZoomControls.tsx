import { Maximize, Minus, Plus } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import type { BoardController } from "../controller";
import type { ViewportStore } from "../viewport/viewportStore";
import { zoomBy, zoomReset, zoomToFit } from "../viewport/zoomActions";
import { IconButton } from "./IconButton";

export function ZoomControls({
  controller,
  viewport,
  modKey,
}: {
  controller: BoardController;
  viewport: ViewportStore;
  modKey: string;
}) {
  const vp = useSyncExternalStore(viewport.subscribe, viewport.get);
  return (
    <div
      role="group"
      aria-label="Zoom"
      className="absolute bottom-3 left-3 z-20 flex items-center gap-1 rounded-lg border bg-background p-1 shadow-sm"
    >
      <IconButton
        label="Zoom out"
        shortcut={`${modKey}-`}
        onClick={() => {
          zoomBy(viewport, 0.8);
        }}
      >
        <Minus />
      </IconButton>
      <Button
        variant="ghost"
        size="sm"
        className="w-14 tabular-nums"
        aria-label={`Zoom ${Math.round(vp.scale * 100)}%, reset to 100%`}
        onClick={() => {
          zoomReset(viewport);
        }}
      >
        {Math.round(vp.scale * 100)}%
      </Button>
      <IconButton
        label="Zoom in"
        shortcut={`${modKey}+`}
        onClick={() => {
          zoomBy(viewport, 1.25);
        }}
      >
        <Plus />
      </IconButton>
      <IconButton
        label="Zoom to fit"
        shortcut="⇧1"
        onClick={() => {
          zoomToFit(controller.store, viewport);
        }}
      >
        <Maximize />
      </IconButton>
    </div>
  );
}
