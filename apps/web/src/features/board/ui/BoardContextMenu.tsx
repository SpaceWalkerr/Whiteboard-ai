import { useSyncExternalStore, type ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { BoardController } from "../controller";
import type { Point } from "../geometry/bounds";

interface Props {
  controller: BoardController;
  modKey: string;
  pasteTarget: () => Point;
  children: ReactNode;
}

/** Right-click menu. Clipboard items use the async Clipboard API (menus have no clipboard event). */
export function BoardContextMenu({ controller, modKey, pasteTarget, children }: Props) {
  const ui = useSyncExternalStore(controller.subscribeUi, controller.getUi);
  const count = ui.selectedIds.size;
  const hasSelection = count > 0;

  const copy = () => {
    const text = controller.copySelection();
    if (text !== null) void navigator.clipboard.writeText(text);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          disabled={!hasSelection}
          onSelect={() => {
            copy();
            controller.deleteSelection();
          }}
        >
          Cut<ContextMenuShortcut>{modKey}X</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasSelection} onSelect={copy}>
          Copy<ContextMenuShortcut>{modKey}C</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => {
            const at = pasteTarget();
            void navigator.clipboard.readText().then((text) => controller.paste(text, at));
          }}
        >
          Paste<ContextMenuShortcut>{modKey}V</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!hasSelection}
          onSelect={() => {
            controller.duplicateSelection();
          }}
        >
          Duplicate<ContextMenuShortcut>{modKey}D</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!hasSelection}
          onSelect={() => {
            controller.deleteSelection();
          }}
        >
          Delete<ContextMenuShortcut>Del</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={!hasSelection}
          onSelect={() => {
            controller.reorderSelection("front");
          }}
        >
          Bring to front<ContextMenuShortcut>{modKey}]</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!hasSelection}
          onSelect={() => {
            controller.reorderSelection("forward");
          }}
        >
          Bring forward<ContextMenuShortcut>]</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!hasSelection}
          onSelect={() => {
            controller.reorderSelection("backward");
          }}
        >
          Send backward<ContextMenuShortcut>[</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!hasSelection}
          onSelect={() => {
            controller.reorderSelection("back");
          }}
        >
          Send to back<ContextMenuShortcut>{modKey}[</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={count < 2}
          onSelect={() => {
            controller.groupSelection();
          }}
        >
          Group<ContextMenuShortcut>{modKey}G</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!hasSelection}
          onSelect={() => {
            controller.ungroupSelection();
          }}
        >
          Ungroup<ContextMenuShortcut>{modKey}⇧G</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={count < 2}>Align</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {(["left", "center", "right", "top", "middle", "bottom"] as const).map((mode) => (
              <ContextMenuItem
                key={mode}
                className="capitalize"
                onSelect={() => {
                  controller.alignSelection(mode);
                }}
              >
                {mode}
              </ContextMenuItem>
            ))}
            <ContextMenuSeparator />
            <ContextMenuItem
              disabled={count < 3}
              onSelect={() => {
                controller.distributeSelection("horizontal");
              }}
            >
              Distribute horizontally
            </ContextMenuItem>
            <ContextMenuItem
              disabled={count < 3}
              onSelect={() => {
                controller.distributeSelection("vertical");
              }}
            >
              Distribute vertically
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => {
            controller.selectAll();
          }}
        >
          Select all<ContextMenuShortcut>{modKey}A</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
