import type Konva from "konva";
import { useEffect, useRef } from "react";
import { Circle, Ellipse, Group, Line, Rect, Transformer } from "react-konva";
import type { BoardSnapshot, Shape } from "@whiteboard/shared/board";
import type { BoardController, BoardUiState } from "../controller";
import { resolveArrow } from "../geometry/arrow";
import type { CanvasInteractions } from "../interaction/pointer";
import { SELECTION_COLOR } from "../model/colors";
import type { Viewport } from "../viewport/viewport";
import { ShapeNode } from "./ShapeNode";

export interface RemoteSelection {
  color: string;
  ids: readonly string[];
}

interface OverlayProps {
  remoteSelections: readonly RemoteSelection[];
  controller: BoardController;
  interactions: CanvasInteractions;
  snapshot: BoardSnapshot;
  ui: BoardUiState;
  viewport: Viewport;
  stageRef: React.RefObject<Konva.Stage | null>;
}

const GUIDE_COLOR = "#db2777";

/** Selection outlines, resize/rotate handles, smart guides, marquee and the shape being drawn. */
export function Overlay({
  controller,
  interactions,
  snapshot,
  ui,
  viewport,
  stageRef,
  remoteSelections,
}: OverlayProps) {
  const selected = [...ui.selectedIds].flatMap((id) => {
    const shape = snapshot.shapes.get(id);
    return shape ? [shape] : [];
  });
  const boxes = selected.filter((s) => s.type !== "arrow");
  const arrows = selected.flatMap((s) => (s.type === "arrow" ? [s] : []));
  const lookup = (id: string) => snapshot.shapes.get(id);
  const px = 1 / viewport.scale;
  const bindTarget = ui.bindTargetId ? snapshot.shapes.get(ui.bindTargetId) : undefined;
  const showTransformer = ui.tool === "select" && ui.editingId === null && boxes.length > 0;
  const draft = ui.draft;

  return (
    <>
      {remoteSelections.flatMap(({ color, ids }) =>
        ids.flatMap((id) => {
          const shape = snapshot.shapes.get(id);
          if (!shape) return [];
          if (shape.type === "arrow") {
            const { start, end } = resolveArrow(shape, lookup);
            return [
              <Line
                key={`${color}-${id}`}
                points={[start.x, start.y, end.x, end.y]}
                stroke={color}
                strokeWidth={3}
                strokeScaleEnabled={false}
                opacity={0.6}
                listening={false}
              />,
            ];
          }
          const pad = 3 * px;
          return [
            <Rect
              key={`${color}-${id}`}
              x={shape.x}
              y={shape.y}
              offsetX={pad}
              offsetY={pad}
              width={shape.w + pad * 2}
              height={shape.h + pad * 2}
              rotation={shape.rotation}
              stroke={color}
              strokeWidth={2}
              strokeScaleEnabled={false}
              listening={false}
            />,
          ];
        }),
      )}
      {boxes.map((shape) => (
        <Rect
          key={shape.id}
          x={shape.x}
          y={shape.y}
          width={shape.w}
          height={shape.h}
          rotation={shape.rotation}
          stroke={SELECTION_COLOR}
          strokeWidth={1}
          strokeScaleEnabled={false}
          listening={false}
        />
      ))}

      {arrows.map((arrow) => {
        const { start, end } = resolveArrow(arrow, lookup);
        const handle = (which: "start" | "end", point: { x: number; y: number }) => (
          <Circle
            key={which}
            x={point.x}
            y={point.y}
            radius={6 * px}
            fill="#ffffff"
            stroke={SELECTION_COLOR}
            strokeWidth={2}
            strokeScaleEnabled={false}
            name="handle"
            onPointerDown={(e) => {
              e.cancelBubble = true;
              interactions.beginArrowEndDrag(arrow.id, which);
            }}
          />
        );
        return (
          <Group key={arrow.id}>
            <Line
              points={[start.x, start.y, end.x, end.y]}
              stroke={SELECTION_COLOR}
              strokeWidth={1}
              strokeScaleEnabled={false}
              dash={[4, 4]}
              listening={false}
            />
            {selected.length === 1 && [handle("start", start), handle("end", end)]}
          </Group>
        );
      })}

      {bindTarget && bindTarget.type !== "arrow" && (
        <BindHighlight shape={bindTarget} pad={4 * px} />
      )}

      {showTransformer && (
        <SelectionTransformer
          controller={controller}
          ids={boxes.map((s) => s.id)}
          stageRef={stageRef}
          snapshot={snapshot}
        />
      )}

      {ui.guides.map((guide, index) => (
        <Line
          key={index}
          points={
            guide.orientation === "vertical"
              ? [guide.position, guide.from, guide.position, guide.to]
              : [guide.from, guide.position, guide.to, guide.position]
          }
          stroke={GUIDE_COLOR}
          strokeWidth={1}
          strokeScaleEnabled={false}
          dash={[4, 4]}
          listening={false}
        />
      ))}

      {ui.marquee && (
        <Rect
          {...{
            x: ui.marquee.x,
            y: ui.marquee.y,
            width: ui.marquee.width,
            height: ui.marquee.height,
          }}
          fill="rgba(37, 99, 235, 0.08)"
          stroke={SELECTION_COLOR}
          strokeWidth={1}
          strokeScaleEnabled={false}
          listening={false}
        />
      )}

      {draft && (
        <Group opacity={0.75} listening={false}>
          <ShapeNode
            shape={draft}
            from={
              draft.type === "arrow" && draft.fromShapeId ? lookup(draft.fromShapeId) : undefined
            }
            to={draft.type === "arrow" && draft.toShapeId ? lookup(draft.toShapeId) : undefined}
            detail="full"
            listening={false}
          />
        </Group>
      )}
    </>
  );
}

function BindHighlight({ shape, pad }: { shape: Shape; pad: number }) {
  const common = {
    stroke: SELECTION_COLOR,
    strokeWidth: 2,
    strokeScaleEnabled: false,
    listening: false,
  };
  return (
    <Group x={shape.x} y={shape.y} rotation={shape.rotation} listening={false}>
      {shape.type === "ellipse" ? (
        <Ellipse
          x={shape.w / 2}
          y={shape.h / 2}
          radiusX={shape.w / 2 + pad}
          radiusY={shape.h / 2 + pad}
          {...common}
        />
      ) : (
        <Rect
          x={-pad}
          y={-pad}
          width={shape.w + pad * 2}
          height={shape.h + pad * 2}
          cornerRadius={6}
          {...common}
        />
      )}
    </Group>
  );
}

function SelectionTransformer({
  controller,
  ids,
  stageRef,
  snapshot,
}: {
  controller: BoardController;
  ids: string[];
  stageRef: React.RefObject<Konva.Stage | null>;
  snapshot: BoardSnapshot;
}) {
  const transformerRef = useRef<Konva.Transformer>(null);
  const key = ids.join(",");

  useEffect(() => {
    const stage = stageRef.current;
    const transformer = transformerRef.current;
    if (!stage || !transformer) return;
    const nodes = key.split(",").flatMap((id) => {
      // Match by function: Konva's "#id" selector can't express ids that start with a digit.
      const node = stage.findOne(
        (candidate: Konva.Node) => candidate.id() === id && candidate.hasName("shape"),
      );
      return node ? [node] : [];
    });
    transformer.nodes(nodes);
    transformer.getLayer()?.batchDraw();
    // Re-attach whenever the selected shapes re-render (their Konva nodes may be replaced).
  }, [key, stageRef, snapshot]);

  const single = ids.length === 1 ? snapshot.shapes.get(ids[0] ?? "") : undefined;
  const textOnly = single?.type === "text";

  return (
    <Transformer
      ref={transformerRef}
      rotateEnabled
      keepRatio={false}
      flipEnabled={false}
      ignoreStroke
      rotationSnaps={[0, 45, 90, 135, 180, 225, 270, 315]}
      rotationSnapTolerance={4}
      borderStroke={SELECTION_COLOR}
      anchorStroke={SELECTION_COLOR}
      anchorSize={8}
      anchorCornerRadius={2}
      {...(textOnly ? { enabledAnchors: ["middle-left", "middle-right"] } : {})}
      boundBoxFunc={(oldBox, newBox) => (newBox.width < 8 || newBox.height < 8 ? oldBox : newBox)}
      onTransformStart={() => {
        controller.beginGesture();
      }}
      onTransform={(e) => {
        const node = e.target;
        const shape = controller.store.getShape(node.id());
        if (!shape) return;
        const w = shape.w * node.scaleX();
        const h = shape.h * node.scaleY();
        // Bake the scale into the model size so strokes and text are never stretched.
        node.scale({ x: 1, y: 1 });
        controller.applyTransforms([
          { id: shape.id, x: node.x(), y: node.y(), w, h, rotation: node.rotation() },
        ]);
      }}
      onTransformEnd={() => {
        controller.endGesture();
      }}
    />
  );
}
