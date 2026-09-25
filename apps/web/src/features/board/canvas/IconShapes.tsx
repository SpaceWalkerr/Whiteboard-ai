import type { IconNode } from "lucide";
import { memo } from "react";
import { Circle, Ellipse, Group, Line, Path, Rect } from "react-konva";

interface IconShapesProps {
  icon: IconNode;
  x: number;
  y: number;
  size: number;
  color: string;
}

function num(value: string | number | undefined): number {
  return typeof value === "number" ? value : Number.parseFloat(value ?? "0") || 0;
}

function parsePoints(value: string | number | undefined): number[] {
  return String(value ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter((v) => Number.isFinite(v));
}

/**
 * Draws a Lucide icon (24×24 SVG node list) as Konva vector shapes, so it stays sharp at any
 * zoom level — unlike an SVG rasterized into an image.
 */
export const IconShapes = memo(function IconShapes({ icon, x, y, size, color }: IconShapesProps) {
  const common = {
    stroke: color,
    strokeWidth: 2,
    lineCap: "round" as const,
    lineJoin: "round" as const,
    listening: false,
    perfectDrawEnabled: false,
  };
  return (
    <Group x={x} y={y} scaleX={size / 24} scaleY={size / 24} listening={false}>
      {icon.map(([tag, attrs], index) => {
        const key = `${tag}-${index}`;
        switch (tag) {
          case "path":
            return <Path key={key} data={String(attrs.d ?? "")} {...common} />;
          case "circle":
            return (
              <Circle
                key={key}
                x={num(attrs.cx)}
                y={num(attrs.cy)}
                radius={num(attrs.r)}
                {...common}
              />
            );
          case "ellipse":
            return (
              <Ellipse
                key={key}
                x={num(attrs.cx)}
                y={num(attrs.cy)}
                radiusX={num(attrs.rx)}
                radiusY={num(attrs.ry)}
                {...common}
              />
            );
          case "rect":
            return (
              <Rect
                key={key}
                x={num(attrs.x)}
                y={num(attrs.y)}
                width={num(attrs.width)}
                height={num(attrs.height)}
                cornerRadius={num(attrs.rx)}
                {...common}
              />
            );
          case "line":
            return (
              <Line
                key={key}
                points={[num(attrs.x1), num(attrs.y1), num(attrs.x2), num(attrs.y2)]}
                {...common}
              />
            );
          case "polyline":
          case "polygon":
            return (
              <Line
                key={key}
                points={parsePoints(attrs.points)}
                closed={tag === "polygon"}
                {...common}
              />
            );
          default:
            return null;
        }
      })}
    </Group>
  );
});
