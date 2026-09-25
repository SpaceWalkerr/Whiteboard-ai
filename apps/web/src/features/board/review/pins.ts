import type { ReviewFinding } from "@whiteboard/graph";
import type { Shape } from "@whiteboard/shared/board";
import { resolveArrow } from "../geometry/arrow";
import { boxBounds, type Point } from "../geometry/bounds";

export interface PinPlacement {
  findingId: string;
  /** 1-based, as listed in the panel. */
  number: number;
  severity: ReviewFinding["severity"];
  /** World position of the pin's anchor. */
  anchor: Point;
  /** Pins on the same shape sit side by side: 0, 1, 2, … */
  stackIndex: number;
}

/**
 * Where each finding's numbered pin goes: on the first of its shapes still on the board —
 * the top-right corner of a box, or the middle of an arrow. Findings whose shapes were all
 * deleted get no pin (they stay in the panel).
 */
export function pinPlacements(
  findings: readonly ReviewFinding[],
  shapes: ReadonlyMap<string, Shape>,
): PinPlacement[] {
  const lookup = (id: string) => shapes.get(id);
  const perShape = new Map<string, number>();
  const placements: PinPlacement[] = [];
  findings.forEach((finding, index) => {
    const shape = finding.shapeIds.map(lookup).find((s) => s !== undefined);
    if (!shape) return;
    let anchor: Point;
    if (shape.type === "arrow") {
      const { start, end } = resolveArrow(shape, lookup);
      anchor = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    } else {
      const bounds = boxBounds(shape);
      anchor = { x: bounds.x + bounds.width, y: bounds.y };
    }
    const stackIndex = perShape.get(shape.id) ?? 0;
    perShape.set(shape.id, stackIndex + 1);
    placements.push({
      findingId: finding.id,
      number: index + 1,
      severity: finding.severity,
      anchor,
      stackIndex,
    });
  });
  return placements;
}
