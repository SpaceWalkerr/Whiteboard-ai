import { useEffect, useRef, useSyncExternalStore } from "react";
import type { Shape } from "@whiteboard/shared/board";
import { isSystemShape } from "@whiteboard/shared/board";
import type { BoardController } from "../controller";
import { resolveArrow } from "../geometry/arrow";
import { shapeText } from "../model/defaults";
import { worldToScreen } from "../viewport/viewport";
import type { ViewportStore } from "../viewport/viewportStore";
import { FONT_FAMILY, LINE_HEIGHT, SYSTEM_LAYOUT } from "./visuals";

/** HTML textarea placed exactly over the shape being edited (canvas text isn't editable). */
export function TextEditor({
  controller,
  viewport,
}: {
  controller: BoardController;
  viewport: ViewportStore;
}) {
  const ui = useSyncExternalStore(controller.subscribeUi, controller.getUi);
  const shape = ui.editingId ? controller.store.getShape(ui.editingId) : undefined;
  if (!shape) return null;
  return <Editor key={shape.id} shape={shape} controller={controller} viewport={viewport} />;
}

function Editor({
  shape,
  controller,
  viewport,
}: {
  shape: Shape;
  controller: BoardController;
  viewport: ViewportStore;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const vp = useSyncExternalStore(viewport.subscribe, viewport.get);
  const committed = useRef(false);
  const multiline = shape.type === "text" || shape.type === "sticky";

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const commit = () => {
    const el = ref.current;
    if (!el || committed.current) return;
    committed.current = true;
    const measured = shape.type === "text" ? el.scrollHeight / vp.scale : null;
    controller.commitText(shape.id, el.value, measured);
  };

  const { fontSize } = shape.style;
  let box: {
    x: number;
    y: number;
    w: number;
    h: number;
    rotation: number;
    align: "left" | "center";
    padding: number;
  };
  if (shape.type === "arrow") {
    const { start, end } = resolveArrow(shape, controller.lookup);
    box = {
      x: (start.x + end.x) / 2 - 100,
      y: (start.y + end.y) / 2 - fontSize,
      w: 200,
      h: fontSize * 2,
      rotation: 0,
      align: "center",
      padding: 4,
    };
  } else if (isSystemShape(shape)) {
    box = {
      x: shape.x,
      y: shape.y + SYSTEM_LAYOUT.labelTop - 4,
      w: shape.w,
      h: fontSize * 2,
      rotation: shape.rotation,
      align: "center",
      padding: 2,
    };
  } else {
    box = {
      x: shape.x,
      y: shape.y,
      w: shape.w,
      h: shape.type === "text" ? Math.max(shape.h, fontSize * LINE_HEIGHT) : shape.h,
      rotation: shape.rotation,
      align: shape.type === "text" || shape.type === "sticky" ? "left" : "center",
      padding: shape.type === "sticky" ? 12 : shape.type === "text" ? 0 : 8,
    };
  }
  const topLeft = worldToScreen(vp, { x: box.x, y: box.y });

  return (
    <textarea
      ref={ref}
      aria-label={multiline ? "Edit text" : "Edit label"}
      defaultValue={shapeText(shape) ?? ""}
      spellCheck
      className="absolute z-10 resize-none overflow-hidden border-0 bg-transparent outline-2 outline-offset-2 outline-blue-600"
      style={{
        left: topLeft.x,
        top: topLeft.y,
        width: box.w * vp.scale,
        height: box.h * vp.scale,
        padding: box.padding * vp.scale,
        transform: box.rotation ? `rotate(${box.rotation}deg)` : undefined,
        transformOrigin: "top left",
        fontFamily: FONT_FAMILY,
        fontSize: fontSize * vp.scale,
        fontWeight: isSystemShape(shape) ? 600 : 400,
        lineHeight: LINE_HEIGHT,
        color: shape.style.stroke,
        textAlign: box.align,
        background: shape.type === "arrow" ? "#ffffff" : "transparent",
      }}
      onInput={(e) => {
        if (shape.type !== "text") return;
        // Grow with the content so nothing is hidden while typing.
        const el = e.currentTarget;
        el.style.height = "auto";
        el.style.height = `${el.scrollHeight}px`;
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        const submit =
          e.key === "Escape" ||
          (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey) && !e.shiftKey);
        if (submit) {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}
