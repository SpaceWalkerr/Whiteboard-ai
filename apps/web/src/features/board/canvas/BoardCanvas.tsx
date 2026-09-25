import type Konva from "konva";
import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { Layer, Stage } from "react-konva";
import type { Shape } from "@whiteboard/shared/board";
import type { BoardController } from "../controller";
import { rectsIntersect } from "../geometry/bounds";
import { shapeBounds } from "../geometry/shapeBounds";
import type { CanvasInteractions, PointerInput } from "../interaction/pointer";
import {
  cullRect,
  detailLevel,
  panBy,
  screenToWorld,
  zoomAt,
  type DetailLevel,
} from "../viewport/viewport";
import type { ViewportStore } from "../viewport/viewportStore";
import { Grid } from "./Grid";
import { Overlay, type CanvasHighlight, type RemoteSelection } from "./Overlay";
import { ShapeNode } from "./ShapeNode";

interface BoardCanvasProps {
  controller: BoardController;
  viewport: ViewportStore;
  interactions: CanvasInteractions;
  isMac: boolean;
  /** Reports the pointer position in world coordinates (used for paste-at-cursor). */
  onPointerWorld: (point: { x: number; y: number }) => void;
  onPointerLeave?: () => void;
  /** Other users' selections, outlined in their colour. */
  remoteSelections?: readonly RemoteSelection[];
  /** Shapes of the design-check finding being looked at. */
  highlight?: CanvasHighlight | null;
  spacePressed: boolean;
  children?: ReactNode;
}

/**
 * True for overlay controls that handle their own dragging: transformer anchors (resize and
 * rotate) and arrow endpoint handles. Board gestures must not start on them.
 */
function isOverlayControl(node: Konva.Node): boolean {
  let current: Konva.Node | null = node;
  while (current) {
    if (current.hasName("handle") || current.getClassName() === "Transformer") return true;
    current = current.getParent();
  }
  return false;
}

/** Id of the shape a Konva node belongs to (the nearest ancestor group named "shape"). */
function shapeIdOf(node: Konva.Node | null): string | null {
  let current: Konva.Node | null = node;
  while (current) {
    if (current.hasName("shape")) return current.id() || null;
    current = current.getParent();
  }
  return null;
}

export function BoardCanvas({
  controller,
  viewport,
  interactions,
  isMac,
  onPointerWorld,
  onPointerLeave,
  remoteSelections = [],
  highlight = null,
  spacePressed,
  children,
}: BoardCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const snapshot = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot);
  const ui = useSyncExternalStore(controller.subscribeUi, controller.getUi);
  const vp = useSyncExternalStore(viewport.subscribe, viewport.get);
  const size = useSyncExternalStore(viewport.subscribe, viewport.getSize);

  // Keep the stage sized to its container.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        viewport.setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [viewport]);

  // Wheel: pan, or zoom with Ctrl/Cmd (trackpad pinch arrives as ctrl+wheel). Non-passive so
  // the browser page itself never zooms or scrolls.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const current = viewport.get();
      if (event.ctrlKey || event.metaKey) {
        const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.01));
        viewport.set(zoomAt(current, point, current.scale * factor));
      } else {
        const dx = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX;
        const dy = event.shiftKey && event.deltaX === 0 ? 0 : event.deltaY;
        viewport.set(panBy(current, -dx, -dy));
      }
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", onWheel);
    };
  }, [viewport]);

  // Double-click uses the browser's dblclick, not Konva's: the browser requires both clicks at
  // the same spot, so two quick clicks placing shapes in different places never count as one.
  const doubleClickRef = useRef<(event: MouseEvent) => void>(() => undefined);
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const onDoubleClick = (event: MouseEvent) => {
      doubleClickRef.current(event);
    };
    element.addEventListener("dblclick", onDoubleClick);
    return () => {
      element.removeEventListener("dblclick", onDoubleClick);
    };
  }, []);

  const toInput = (event: PointerEvent | MouseEvent, targetId: string | null): PointerInput => {
    const rect = containerRef.current?.getBoundingClientRect();
    const screen = { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
    const world = screenToWorld(viewport.get(), screen);
    onPointerWorld(world);
    return {
      world,
      screen,
      targetId,
      shift: event.shiftKey,
      alt: event.altKey,
      mod: isMac ? event.metaKey : event.ctrlKey,
      button: event.button,
    };
  };

  const targetAt = (event: MouseEvent): string | null => {
    const stage = stageRef.current;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!stage || !rect) return null;
    return shapeIdOf(
      stage.getIntersection({ x: event.clientX - rect.left, y: event.clientY - rect.top }),
    );
  };

  useEffect(() => {
    doubleClickRef.current = (event) => {
      interactions.doubleClick(toInput(event, targetAt(event)));
    };
  });

  // During a gesture, follow the pointer on the window so drags continue outside the canvas.
  const startWindowTracking = () => {
    const onMove = (event: PointerEvent) => {
      interactions.move(toInput(event, targetAt(event)));
    };
    const onUp = (event: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      interactions.up(toInput(event, targetAt(event)));
    };
    const onCancel = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      interactions.cancel();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  // Cull to what is (nearly) on screen. cullRect is snapped to a coarse grid, so this list —
  // and the React work — only changes every half-screen of panning.
  const cull = cullRect(vp, size);
  const cullKey = `${cull.x}:${cull.y}:${cull.width}:${cull.height}`;
  const visible = useMemo(() => {
    const lookup = (id: string) => snapshot.shapes.get(id);
    const area = { x: cull.x, y: cull.y, width: cull.width, height: cull.height };
    return snapshot.ordered.filter((shape) => rectsIntersect(shapeBounds(shape, lookup), area));
    // cull is fully described by cullKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, cullKey]);
  const detail = detailLevel(vp.scale);

  const cursor = spacePressed
    ? (interactions.cursorHint ?? "grab")
    : ui.tool === "select"
      ? "default"
      : "crosshair";

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 touch-none overflow-hidden bg-white select-none"
      style={{ cursor }}
      onPointerMove={(event) => {
        if (!interactions.active) toInput(event.nativeEvent, null);
      }}
      onPointerLeave={() => {
        onPointerLeave?.();
      }}
    >
      <Stage
        ref={stageRef}
        width={size.width}
        height={size.height}
        x={vp.x}
        y={vp.y}
        scaleX={vp.scale}
        scaleY={vp.scale}
        onPointerDown={(e) => {
          if (e.evt.button === 2) {
            // Right-click: make sure the context menu acts on what was clicked.
            const id = shapeIdOf(e.target);
            if (id && !controller.getUi().selectedIds.has(id)) controller.select([id]);
            return;
          }
          if (isOverlayControl(e.target)) return;
          interactions.down(toInput(e.evt, shapeIdOf(e.target)));
          if (interactions.active) startWindowTracking();
        }}
      >
        <Layer listening={false}>
          <Grid viewport={vp} size={size} />
        </Layer>
        <Layer>
          <ShapesLayer
            shapes={visible}
            lookup={snapshot.shapes}
            detail={detail}
            editingId={ui.editingId}
          />
        </Layer>
        <Layer>
          <Overlay
            controller={controller}
            interactions={interactions}
            snapshot={snapshot}
            ui={ui}
            viewport={vp}
            stageRef={stageRef}
            remoteSelections={remoteSelections}
            highlight={highlight}
          />
        </Layer>
      </Stage>
      {children}
    </div>
  );
}

function ShapesLayer({
  shapes,
  lookup,
  detail,
  editingId,
}: {
  shapes: readonly Shape[];
  lookup: ReadonlyMap<string, Shape>;
  detail: DetailLevel;
  editingId: string | null;
}) {
  return (
    <>
      {shapes.map((shape) => (
        <ShapeNode
          key={shape.id}
          shape={shape}
          from={
            shape.type === "arrow" && shape.fromShapeId ? lookup.get(shape.fromShapeId) : undefined
          }
          to={shape.type === "arrow" && shape.toShapeId ? lookup.get(shape.toShapeId) : undefined}
          detail={detail}
          hideText={shape.id === editingId}
        />
      ))}
    </>
  );
}
