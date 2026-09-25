import { useEffect } from "react";
import type { BoardController } from "../controller";
import type { Point } from "../geometry/bounds";
import { isEditableTarget } from "./useBoardKeyboard";

/**
 * Copy/cut/paste through the browser's clipboard events (no permission prompt, works across
 * tabs and boards). Fields keep their native clipboard behaviour.
 */
export function useClipboard(controller: BoardController, pasteTarget: () => Point): void {
  useEffect(() => {
    const onCopy = (event: ClipboardEvent) => {
      if (isEditableTarget(document.activeElement)) return;
      const text = controller.copySelection();
      if (text === null || !event.clipboardData) return;
      event.clipboardData.setData("text/plain", text);
      event.preventDefault();
    };
    const onCut = (event: ClipboardEvent) => {
      if (isEditableTarget(document.activeElement)) return;
      const text = controller.cutSelection();
      if (text === null || !event.clipboardData) return;
      event.clipboardData.setData("text/plain", text);
      event.preventDefault();
    };
    const onPaste = (event: ClipboardEvent) => {
      if (isEditableTarget(document.activeElement)) return;
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (controller.paste(text, pasteTarget())) event.preventDefault();
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste);
    };
  }, [controller, pasteTarget]);
}
