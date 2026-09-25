import {
  Circle,
  Download,
  Keyboard,
  Magnet,
  MousePointer2,
  MoveUpRight,
  Pencil,
  Redo2,
  Square,
  StickyNote,
  Type,
  Undo2,
} from "lucide-react";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { BoardController, ToolId } from "../controller";
import { exportPng, exportSvg } from "../export/download";
import { IconButton } from "./IconButton";

const TOOLS: { id: ToolId; label: string; key: string; icon: typeof Square }[] = [
  { id: "select", label: "Select", key: "V", icon: MousePointer2 },
  { id: "rectangle", label: "Rectangle", key: "R", icon: Square },
  { id: "ellipse", label: "Ellipse", key: "O", icon: Circle },
  { id: "text", label: "Text", key: "T", icon: Type },
  { id: "sticky", label: "Sticky note", key: "N", icon: StickyNote },
  { id: "freehand", label: "Pen", key: "P", icon: Pencil },
  { id: "arrow", label: "Arrow", key: "A", icon: MoveUpRight },
];

export function Toolbar({
  controller,
  modKey,
  onShowShortcuts,
  readOnly = false,
}: {
  controller: BoardController;
  modKey: string;
  onShowShortcuts: () => void;
  /** Viewers get export and shortcuts only; no drawing tools, undo or snapping. */
  readOnly?: boolean;
}) {
  const ui = useSyncExternalStore(controller.subscribeUi, controller.getUi);
  const history = useSyncExternalStore(controller.history.subscribe, controller.history.getState);
  const isBasicTool = TOOLS.some((t) => t.id === ui.tool);

  return (
    <div
      role="toolbar"
      aria-label="Board tools"
      className="absolute top-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-lg border bg-background p-1 shadow-sm"
    >
      {!readOnly && (
        <>
          <ToggleGroup
            type="single"
            aria-label="Drawing tool"
            value={isBasicTool ? ui.tool : ""}
            onValueChange={(value) => {
              if (value) controller.setTool(value as ToolId);
            }}
          >
            {TOOLS.map(({ id, label, key, icon: Icon }) => (
              <Tooltip key={id}>
                <TooltipTrigger asChild>
                  <ToggleGroupItem value={id} aria-label={label}>
                    <Icon />
                  </ToggleGroupItem>
                </TooltipTrigger>
                <TooltipContent>
                  {label} ({key})
                </TooltipContent>
              </Tooltip>
            ))}
          </ToggleGroup>
          <div className="mx-1 h-6 w-px bg-border" aria-hidden="true" />
          <IconButton
            label="Undo"
            shortcut={`${modKey}Z`}
            onClick={() => {
              controller.undo();
            }}
            disabled={!history.canUndo}
          >
            <Undo2 />
          </IconButton>
          <IconButton
            label="Redo"
            shortcut={`${modKey}⇧Z`}
            onClick={() => {
              controller.redo();
            }}
            disabled={!history.canRedo}
          >
            <Redo2 />
          </IconButton>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={ui.gridSnap ? "secondary" : "ghost"}
                size="icon"
                aria-label="Snap to grid"
                aria-pressed={ui.gridSnap}
                onClick={() => {
                  controller.toggleGridSnap();
                }}
              >
                <Magnet />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Snap to grid</TooltipContent>
          </Tooltip>
        </>
      )}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Export">
                <Download />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Export</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void exportPng(controller.store.getSnapshot().ordered)}>
            Export as PNG
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => exportSvg(controller.store.getSnapshot().ordered)}>
            Export as SVG
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <IconButton label="Keyboard shortcuts" shortcut="?" onClick={onShowShortcuts}>
        <Keyboard />
      </IconButton>
    </div>
  );
}
