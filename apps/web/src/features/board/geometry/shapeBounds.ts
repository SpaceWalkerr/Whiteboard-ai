import type { Shape } from "@whiteboard/shared/board";
import { arrowBounds, resolveArrow, type ShapeLookup } from "./arrow";
import { boxBounds, type Rect } from "./bounds";

/** World-space AABB of any shape; arrows use their resolved (bound) geometry. */
export function shapeBounds(shape: Shape, lookup: ShapeLookup): Rect {
  return shape.type === "arrow" ? arrowBounds(resolveArrow(shape, lookup)) : boxBounds(shape);
}
