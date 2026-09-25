import { memo } from "react";
import { Arrow, Ellipse, Group, Line, Rect, Text } from "react-konva";
import type { ArrowShape, Shape, SystemShape } from "@whiteboard/shared/board";
import { isSystemShape } from "@whiteboard/shared/board";
import { resolveArrow } from "../geometry/arrow";
import { systemShapeCaption, systemShapeIcon } from "../model/systemShapes";
import type { DetailLevel } from "../viewport/viewport";
import { IconShapes } from "./IconShapes";
import { measureTextWidth } from "./measure";
import { compact } from "./props";
import { ARROW_DASH, FONT_FAMILY, LINE_HEIGHT, STROKE_DASH, SYSTEM_LAYOUT } from "./visuals";

/** Fully transparent fills still receive clicks, so hollow shapes remain selectable. */
const HIT_FILL = "rgba(0,0,0,0)";

interface ShapeNodeProps {
  shape: Shape;
  /** Bound shapes, for arrows. Passed explicitly so memo re-renders when they move. */
  from?: Shape | undefined;
  to?: Shape | undefined;
  detail: DetailLevel;
  /** Hide the shape's own text while the HTML editor is open on top of it. */
  hideText?: boolean;
  /** Drafts (shapes being drawn) are not hit-testable. */
  listening?: boolean;
}

function dash(style: Shape["style"], pattern: readonly number[]): number[] | undefined {
  return pattern.length > 0 ? pattern.map((d) => d * Math.max(1, style.strokeWidth)) : undefined;
}

function strokeProps(
  shape: Shape,
  pattern: readonly number[] = STROKE_DASH[shape.style.strokeStyle],
) {
  const { style } = shape;
  return {
    ...compact({
      stroke: style.strokeWidth > 0 ? style.stroke : undefined,
      dash: dash(style, pattern),
    }),
    strokeWidth: style.strokeWidth,
    fill: style.fill === "transparent" ? HIT_FILL : style.fill,
    perfectDrawEnabled: false,
  };
}

function shapeIdentity(shape: Shape, listening: boolean) {
  return listening ? { id: shape.id, name: "shape" } : {};
}

/** Renders one shape. Memoized on object identity, which BoardStore keeps stable. */
export const ShapeNode = memo(function ShapeNode(props: ShapeNodeProps) {
  const { shape, listening = true } = props;
  if (shape.type === "arrow") return <ArrowNode {...props} shape={shape} />;

  return (
    <Group
      {...shapeIdentity(shape, listening)}
      x={shape.x}
      y={shape.y}
      rotation={shape.rotation}
      opacity={shape.style.opacity}
      listening={listening}
    >
      <BoxBody {...props} />
    </Group>
  );
});

function BoxBody({ shape, detail, hideText }: ShapeNodeProps) {
  const { style } = shape;
  const showText = !hideText && detail === "full";
  const textProps = {
    fontFamily: FONT_FAMILY,
    lineHeight: LINE_HEIGHT,
    fontSize: style.fontSize,
    fill: style.stroke,
    listening: false,
  };

  switch (shape.type) {
    case "rectangle":
      return (
        <>
          <Rect width={shape.w} height={shape.h} cornerRadius={4} {...strokeProps(shape)} />
          {showText && shape.label && (
            <Text
              text={shape.label}
              width={shape.w}
              height={shape.h}
              padding={8}
              align="center"
              verticalAlign="middle"
              {...textProps}
            />
          )}
        </>
      );
    case "ellipse":
      return (
        <>
          <Ellipse
            x={shape.w / 2}
            y={shape.h / 2}
            radiusX={shape.w / 2}
            radiusY={shape.h / 2}
            {...strokeProps(shape)}
          />
          {showText && shape.label && (
            <Text
              text={shape.label}
              width={shape.w}
              height={shape.h}
              padding={8}
              align="center"
              verticalAlign="middle"
              {...textProps}
            />
          )}
        </>
      );
    case "text":
      return (
        <>
          {/* Transparent hit area so the whole text box is clickable. */}
          <Rect width={shape.w} height={shape.h} fill={HIT_FILL} />
          {!hideText && <Text text={shape.text} width={shape.w} {...textProps} />}
        </>
      );
    case "sticky":
      return (
        <>
          <Rect
            width={shape.w}
            height={shape.h}
            cornerRadius={2}
            fill={style.fill === "transparent" ? "#fef08a" : style.fill}
            perfectDrawEnabled={false}
          />
          {showText && (
            <Text text={shape.text} width={shape.w} height={shape.h} padding={12} {...textProps} />
          )}
        </>
      );
    case "freehand":
      return (
        <Line
          points={shape.points}
          stroke={style.stroke}
          strokeWidth={style.strokeWidth}
          {...compact({ dash: dash(style, STROKE_DASH[style.strokeStyle]) })}
          lineCap="round"
          lineJoin="round"
          hitStrokeWidth={Math.max(12, style.strokeWidth)}
          perfectDrawEnabled={false}
        />
      );
    default:
      return isSystemShape(shape) ? (
        <SystemBody shape={shape} detail={detail} hideText={Boolean(hideText)} />
      ) : null;
  }
}

function SystemBody({
  shape,
  detail,
  hideText,
}: {
  shape: SystemShape;
  detail: DetailLevel;
  hideText: boolean;
}) {
  const replica = shape.type === "database" && shape.role === "replica";
  const { style } = shape;
  const pattern = replica ? STROKE_DASH.dashed : STROKE_DASH[style.strokeStyle];
  const full = detail === "full";
  const caption = systemShapeCaption(shape);
  return (
    <>
      <Rect
        width={shape.w}
        height={shape.h}
        cornerRadius={SYSTEM_LAYOUT.radius}
        {...strokeProps(shape, pattern)}
      />
      {full && (
        <IconShapes
          icon={systemShapeIcon(shape)}
          x={shape.w / 2 - SYSTEM_LAYOUT.iconSize / 2}
          y={SYSTEM_LAYOUT.iconTop}
          size={SYSTEM_LAYOUT.iconSize}
          color={style.stroke}
        />
      )}
      {full && !hideText && (
        <Text
          text={shape.label}
          y={SYSTEM_LAYOUT.labelTop}
          width={shape.w}
          align="center"
          fontStyle="600"
          fontSize={style.fontSize}
          fontFamily={FONT_FAMILY}
          fill={style.stroke}
          wrap="none"
          ellipsis
          padding={0}
          listening={false}
        />
      )}
      {full && caption && (
        <Text
          text={caption}
          y={SYSTEM_LAYOUT.labelTop + style.fontSize * LINE_HEIGHT + 2}
          width={shape.w}
          align="center"
          fontSize={SYSTEM_LAYOUT.captionSize}
          fontFamily={FONT_FAMILY}
          fill={SYSTEM_LAYOUT.captionColor}
          listening={false}
        />
      )}
    </>
  );
}

function ArrowNode({
  shape,
  from,
  to,
  hideText,
  listening = true,
}: ShapeNodeProps & { shape: ArrowShape }) {
  const { start, end } = resolveArrow(shape, (id) =>
    id === from?.id ? from : id === to?.id ? to : undefined,
  );
  const { style } = shape;
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const labelWidth = shape.label ? measureTextWidth(shape.label, style.fontSize) + 12 : 0;
  return (
    <Group {...shapeIdentity(shape, listening)} opacity={style.opacity} listening={listening}>
      <Arrow
        points={[start.x, start.y, end.x, end.y]}
        stroke={style.stroke}
        fill={style.stroke}
        strokeWidth={style.strokeWidth}
        {...compact({ dash: dash(style, ARROW_DASH[shape.edgeType]) })}
        pointerLength={10}
        pointerWidth={10}
        lineCap="round"
        hitStrokeWidth={14}
        perfectDrawEnabled={false}
      />
      {shape.label && !hideText && (
        <>
          <Rect
            x={mid.x - labelWidth / 2}
            y={mid.y - style.fontSize * 0.8}
            width={labelWidth}
            height={style.fontSize * 1.6}
            cornerRadius={4}
            fill="#ffffff"
          />
          <Text
            text={shape.label}
            x={mid.x - labelWidth / 2}
            y={mid.y - style.fontSize / 2}
            width={labelWidth}
            align="center"
            fontSize={style.fontSize}
            fontFamily={FONT_FAMILY}
            fill={style.stroke}
            listening={false}
          />
        </>
      )}
    </Group>
  );
}
