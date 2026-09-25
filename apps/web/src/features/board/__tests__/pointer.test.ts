import { describe, expect, it } from "vitest";
import { isOnOutline, resolveArrow } from "../geometry/arrow";
import { pointer, rect, setup } from "./fixtures";

describe("CanvasInteractions", () => {
  it("draws a rectangle by dragging, then selects it", () => {
    const { controller, interactions, store } = setup();
    controller.setTool("rectangle");
    interactions.down(pointer(10, 10));
    interactions.move(pointer(110, 60));
    expect(controller.getUi().draft).toMatchObject({ type: "rectangle", w: 100, h: 50 });
    interactions.up(pointer(110, 60));

    const [shape] = store.getSnapshot().ordered;
    expect(shape).toMatchObject({ type: "rectangle", x: 10, y: 10, w: 100, h: 50 });
    expect(controller.getUi().draft).toBeNull();
    expect(controller.getUi().tool).toBe("select");
  });

  it("places a default-size system shape on click", () => {
    const { controller, interactions, store } = setup();
    controller.setTool("database");
    interactions.down(pointer(500, 500));
    interactions.up(pointer(500, 500));
    expect(store.getSnapshot().ordered[0]).toMatchObject({
      type: "database",
      x: 420,
      y: 452,
      w: 160,
      h: 96,
    });
  });

  it("moves a shape as one undo step and snaps it to a neighbour", () => {
    const { controller, interactions, store } = setup();
    store.createShapes([rect("a", 0, 0), rect("b", 0, 200)]);
    interactions.down(pointer(50, 225, "b"));
    interactions.move(pointer(150, 225, "b"));
    interactions.move(pointer(153, 225, "b"));
    interactions.up(pointer(153, 225, "b"));
    // 103 is within 6px of a's right edge (100) → snapped.
    expect(store.getShape("b")?.x).toBe(100);

    controller.undo();
    expect(store.getShape("b")?.x).toBe(0);
  });

  it("does not snap while the modifier is held", () => {
    const { interactions, store } = setup();
    store.createShapes([rect("a", 0, 0), rect("b", 0, 200)]);
    interactions.down(pointer(50, 225, "b"));
    interactions.move(pointer(153, 225, "b", { mod: true }));
    interactions.up(pointer(153, 225, "b", { mod: true }));
    expect(store.getShape("b")?.x).toBe(103);
  });

  it("treats a tiny movement as a click, not a move", () => {
    const { controller, interactions, store, history } = setup();
    store.createShape(rect("a", 0, 0));
    history.stopCapturing();
    interactions.down(pointer(10, 10, "a"));
    interactions.move(pointer(11, 11, "a"));
    interactions.up(pointer(11, 11, "a"));
    expect(store.getShape("a")?.x).toBe(0);
    expect([...controller.getUi().selectedIds]).toEqual(["a"]);
  });

  it("selects shapes touched by a marquee", () => {
    const { controller, interactions, store } = setup();
    store.createShapes([rect("a", 0, 0), rect("b", 500, 500)]);
    interactions.down(pointer(-10, -10));
    interactions.move(pointer(60, 60));
    interactions.up(pointer(60, 60));
    expect([...controller.getUi().selectedIds]).toEqual(["a"]);
    expect(controller.getUi().marquee).toBeNull();
  });

  it("creates an arrow bound at both ends when dragged between shapes", () => {
    const { controller, interactions, store } = setup();
    store.createShapes([rect("a", 0, 0), rect("b", 300, 0)]);
    controller.setTool("arrow");
    interactions.down(pointer(50, 25, "a"));
    interactions.move(pointer(350, 25, "b"));
    expect(controller.getUi().bindTargetId).toBe("b");
    interactions.up(pointer(350, 25, "b"));

    const arrow = store.getSnapshot().ordered.find((s) => s.type === "arrow");
    expect(arrow).toMatchObject({ fromShapeId: "a", toShapeId: "b" });
    if (arrow?.type !== "arrow") throw new Error("no arrow");

    // Move b: the arrow still meets both outlines.
    interactions.down(pointer(350, 25, "b"));
    interactions.move(pointer(350, 400, "b"));
    interactions.up(pointer(350, 400, "b"));
    const current = store.getShape(arrow.id);
    if (current?.type !== "arrow") throw new Error("arrow missing");
    const geometry = resolveArrow(current, controller.lookup);
    const a = store.getShape("a");
    const b = store.getShape("b");
    if (!a || !b) throw new Error("shapes missing");
    expect(isOnOutline(a, geometry.start)).toBe(true);
    expect(isOnOutline(b, geometry.end)).toBe(true);
  });

  it("does not create a zero-length free arrow", () => {
    const { controller, interactions, store } = setup();
    controller.setTool("arrow");
    interactions.down(pointer(0, 0));
    interactions.up(pointer(2, 2));
    expect(store.getSnapshot().ordered).toEqual([]);
  });

  it("rebinds an arrow end dragged onto another shape", () => {
    const { controller, interactions, store } = setup();
    store.createShapes([rect("a", 0, 0), rect("b", 300, 0), rect("c", 300, 300)]);
    controller.setTool("arrow");
    interactions.down(pointer(50, 25, "a"));
    interactions.up(pointer(350, 25, "b"));
    const arrow = store.getSnapshot().ordered.find((s) => s.type === "arrow");
    if (!arrow) throw new Error("no arrow");

    interactions.beginArrowEndDrag(arrow.id, "end");
    interactions.move(pointer(350, 325, "c"));
    interactions.up(pointer(350, 325, "c"));
    expect(store.getShape(arrow.id)).toMatchObject({ toShapeId: "c" });
  });

  it("draws a freehand stroke and keeps the pen tool", () => {
    const { controller, interactions, store } = setup();
    controller.setTool("freehand");
    interactions.down(pointer(0, 0));
    for (let i = 1; i <= 20; i++) interactions.move(pointer(i * 5, Math.sin(i) * 20));
    interactions.up(pointer(100, 0));
    const [stroke] = store.getSnapshot().ordered;
    expect(stroke?.type).toBe("freehand");
    expect(controller.getUi().tool).toBe("freehand");
  });

  it("pans with space held", () => {
    const { interactions, viewport } = setup();
    interactions.setSpacePressed(true);
    interactions.down(pointer(100, 100));
    interactions.move(pointer(150, 130));
    interactions.up(pointer(150, 130));
    expect(viewport.get()).toMatchObject({ x: 50, y: 30 });
  });

  it("creates and edits a text box on double-click in empty space", () => {
    const { controller, interactions, store } = setup();
    interactions.doubleClick(pointer(100, 100));
    const [text] = store.getSnapshot().ordered;
    expect(text?.type).toBe("text");
    expect(controller.getUi().editingId).toBe(text?.id);
  });
});
