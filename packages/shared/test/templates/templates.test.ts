import { describe, expect, it } from "vitest";
import { BoardStore, shapeSchema } from "../../src/board";
import {
  BOARD_TEMPLATES,
  buildTemplateShapes,
  templateBySlug,
  TEMPLATE_SLUGS,
} from "../../src/templates";

describe("board templates", () => {
  it("have unique, URL-safe slugs", () => {
    expect(new Set(TEMPLATE_SLUGS).size).toBe(TEMPLATE_SLUGS.length);
    for (const slug of TEMPLATE_SLUGS) expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(TEMPLATE_SLUGS.length).toBeGreaterThanOrEqual(10);
  });

  it.each(BOARD_TEMPLATES.map((t) => [t.slug, t] as const))(
    "%s: every shape is valid and every arrow joins two shapes on the board",
    (_slug, template) => {
      const ids = new Set(template.shapes.map((s) => s.id));
      expect(ids.size).toBe(template.shapes.length);
      for (const shape of template.shapes) {
        expect(shapeSchema.safeParse(shape).success).toBe(true);
        if (shape.type === "arrow") {
          expect(shape.fromShapeId && ids.has(shape.fromShapeId)).toBe(true);
          expect(shape.toShapeId && ids.has(shape.toShapeId)).toBe(true);
        }
      }
      // Shapes don't overlap: nothing hides another component in the preview or on the board.
      const boxes = template.shapes.filter((s) => s.type !== "arrow");
      for (const a of boxes)
        for (const b of boxes)
          if (a !== b)
            expect(
              a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y,
            ).toBe(true);
    },
  );

  it.each(BOARD_TEMPLATES.map((t) => [t.slug, t] as const))(
    "%s: page copy fits search results (title, description)",
    (_slug, template) => {
      expect(template.description.length).toBeLessThanOrEqual(160);
      expect(template.description.length).toBeGreaterThanOrEqual(70);
      expect(template.heading.length).toBeLessThanOrEqual(70);
      expect(template.components.length).toBeGreaterThan(0);
      expect(template.flow.length).toBeGreaterThan(0);
    },
  );

  it("loads into a board store in one transaction", () => {
    const template = templateBySlug("url-shortener");
    if (!template) throw new Error("missing template");
    const store = new BoardStore({ userId: "u1" });
    store.createShapes(template.shapes);
    expect(store.getSnapshot().ordered).toHaveLength(template.shapes.length);
    // Arrows render above the components they join.
    expect(store.getSnapshot().ordered.at(-1)?.type).toBe("arrow");
  });

  it("refuses an arrow to a component that doesn't exist", () => {
    expect(() =>
      buildTemplateShapes(
        [{ id: "a", type: "service", label: "A", col: 0, row: 0 }],
        [{ from: "a", to: "missing" }],
      ),
    ).toThrow(/unknown shape/);
  });

  it("returns undefined for unknown slugs", () => {
    expect(templateBySlug("nope")).toBeUndefined();
  });
});
