import { useEffect } from "react";
import type { BoardController } from "../controller";
import type { CanvasInteractions } from "../interaction/pointer";
import type { ViewportStore } from "../viewport/viewportStore";
import { zoomBy, zoomReset, zoomToFit } from "../viewport/zoomActions";
import { matchShortcut, type ShortcutAction } from "./shortcuts";

/** Typing in a field, or using a dialog/menu, must never trigger board shortcuts. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return true;
  return target.closest('[role="dialog"], [role="menu"], [role="listbox"]') !== null;
}

/** Tab cycles shapes only when focus is on the canvas, so Tab still moves between controls. */
function focusOnCanvas(target: EventTarget | null): boolean {
  return (
    target === document.body ||
    (target instanceof HTMLElement && target.closest("[data-board-canvas]") !== null)
  );
}

interface Options {
  controller: BoardController;
  interactions: CanvasInteractions;
  viewport: ViewportStore;
  mac: boolean;
  onShowShortcuts: () => void;
  onQuickInsert: () => void;
  onSpaceChange: (pressed: boolean) => void;
  /** Gets first go at Escape (e.g. to stop following someone); return true if handled. */
  onEscape?: (() => boolean) | undefined;
}

const NUDGE: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

export function useBoardKeyboard(options: Options): void {
  const {
    controller,
    interactions,
    viewport,
    mac,
    onShowShortcuts,
    onQuickInsert,
    onSpaceChange,
    onEscape,
  } = options;

  useEffect(() => {
    const run = (action: ShortcutAction) => {
      switch (action) {
        case "tool.select":
          controller.setTool("select");
          break;
        case "tool.rectangle":
          controller.setTool("rectangle");
          break;
        case "tool.ellipse":
          controller.setTool("ellipse");
          break;
        case "tool.text":
          controller.setTool("text");
          break;
        case "tool.sticky":
          controller.setTool("sticky");
          break;
        case "tool.freehand":
          controller.setTool("freehand");
          break;
        case "tool.arrow":
          controller.setTool("arrow");
          break;
        case "quickInsert":
          onQuickInsert();
          break;
        case "undo":
          controller.undo();
          break;
        case "redo":
          controller.redo();
          break;
        case "duplicate":
          controller.duplicateSelection();
          break;
        case "delete":
          controller.deleteSelection();
          break;
        case "selectAll":
          controller.selectAll();
          break;
        case "escape":
          if (onEscape?.()) break;
          if (interactions.active) interactions.cancel();
          else if (controller.getUi().tool !== "select") controller.setTool("select");
          else controller.clearSelection();
          break;
        case "selectNext":
          controller.selectAdjacent(1);
          break;
        case "selectPrevious":
          controller.selectAdjacent(-1);
          break;
        case "group":
          controller.groupSelection();
          break;
        case "ungroup":
          controller.ungroupSelection();
          break;
        case "bringForward":
          controller.reorderSelection("forward");
          break;
        case "sendBackward":
          controller.reorderSelection("backward");
          break;
        case "bringToFront":
          controller.reorderSelection("front");
          break;
        case "sendToBack":
          controller.reorderSelection("back");
          break;
        case "zoomToFit":
          zoomToFit(controller.store, viewport);
          break;
        case "zoomReset":
          zoomReset(viewport);
          break;
        case "zoomIn":
          zoomBy(viewport, 1.25);
          break;
        case "zoomOut":
          zoomBy(viewport, 0.8);
          break;
        case "showShortcuts":
          onShowShortcuts();
          break;
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (event.key === " ") {
        event.preventDefault();
        if (!event.repeat) onSpaceChange(true);
        return;
      }
      const nudge = NUDGE[event.key];
      if (nudge && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        controller.nudgeSelection(nudge[0] * step, nudge[1] * step);
        return;
      }
      if (event.key === "Enter" && controller.getUi().selectedIds.size === 1) {
        event.preventDefault();
        const [id] = controller.getUi().selectedIds;
        if (id) controller.startEditing(id);
        return;
      }
      const action = matchShortcut(event, mac);
      if (!action) return;
      if ((action === "selectNext" || action === "selectPrevious") && !focusOnCanvas(event.target))
        return;
      event.preventDefault();
      run(action);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === " ") onSpaceChange(false);
    };
    const onBlur = () => {
      onSpaceChange(false);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [
    controller,
    interactions,
    viewport,
    mac,
    onShowShortcuts,
    onQuickInsert,
    onSpaceChange,
    onEscape,
  ]);
}
