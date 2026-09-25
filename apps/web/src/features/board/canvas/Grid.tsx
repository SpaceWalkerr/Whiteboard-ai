import { memo } from "react";
import { Shape } from "react-konva";
import { GRID_COLOR } from "../model/colors";
import { visibleWorldRect, type Size, type Viewport } from "../viewport/viewport";

const BASE_SPACING = 20;

/** Dotted grid drawn in one pass for the visible area only. Spacing grows when zoomed out. */
export const Grid = memo(function Grid({ viewport, size }: { viewport: Viewport; size: Size }) {
  let spacing = BASE_SPACING;
  while (spacing * viewport.scale < 12) spacing *= 5;
  const area = visibleWorldRect(viewport, size);
  const radius = 1 / viewport.scale;

  return (
    <Shape
      listening={false}
      perfectDrawEnabled={false}
      sceneFunc={(context) => {
        const ctx = context._context;
        ctx.fillStyle = GRID_COLOR;
        const x0 = Math.floor(area.x / spacing) * spacing;
        const y0 = Math.floor(area.y / spacing) * spacing;
        for (let x = x0; x <= area.x + area.width; x += spacing) {
          for (let y = y0; y <= area.y + area.height; y += spacing) {
            ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
          }
        }
      }}
    />
  );
});
