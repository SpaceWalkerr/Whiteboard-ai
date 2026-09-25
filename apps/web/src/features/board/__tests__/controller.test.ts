import { describe, expect, it } from "vitest";
import { serializeClipboard } from "@whiteboard/shared/board";
import { resolveArrow } from "../geometry/arrow";
import { createArrowShape } from "../model/defaults";
import { box, rect, setup } from "./fixtures";

describe("BoardController", () => {
  it("adds a shape, selects it and returns to the select tool", () => {
    const { controller, store } = setup();
    controller.setTool("rectangle");
    controller.addShape(rect("r", 0, 0));
    expect(store.getShape("r")).toBeDefined();
    expect([...controller.getUi().selectedIds]).toEqual(["r"]);
    expect(controller.getUi().tool).toBe("select");
  });

  it("selects whole groups", () => {
    const { controller, store } = setup();
    store.createShapes([
      rect("a", 0, 0, 10, 10, { groupId: "g" }),
      rect("b", 50, 0, 10, 10, { groupId: "g" }),
      rect("c", 99, 0),
    ]);
    controller.select(["a"]);
    expect([...controller.getUi().selectedIds].sort()).toEqual(["a", "b"]);
  });

  it("groups and ungroups as single undo steps", () => {
    const { controller, store } = setup();
    store.createShapes([rect("a", 0, 0), rect("b", 200, 0)]);
    controller.select(["a", "b"]);
    controller.groupSelection();
    const groupId = store.getShape("a")?.groupId;
    expect(groupId).toBeTruthy();
    expect(store.getShape("b")?.groupId).toBe(groupId);

    controller.undo();
    expect(store.getShape("a")?.groupId).toBeNull();
  });

  it("deletes the selection together with bound arrows", () => {
    const { controller, store } = setup();
    const arrow = createArrowShape(
      { start: { x: 0, y: 0 }, end: { x: 0, y: 0 }, fromShapeId: "a", toShapeId: "b" },
      { id: "arr", zIndex: "a3", userId: "t", now: 0 },
    );
    store.createShapes([rect("a", 0, 0), rect("b", 300, 0), arrow]);
    controller.select(["a"]);
    controller.deleteSelection();
    expect(store.getSnapshot().ordered.map((s) => s.id)).toEqual(["b"]);
    expect(controller.getUi().selectedIds.size).toBe(0);
  });

  it("duplicates with an offset, keeping arrows bound to the copies", () => {
    const { controller, store } = setup();
    const arrow = createArrowShape(
      { start: { x: 0, y: 0 }, end: { x: 0, y: 0 }, fromShapeId: "a", toShapeId: "b" },
      { id: "arr", zIndex: "a3", userId: "t", now: 0 },
    );
    store.createShapes([rect("a", 0, 0), rect("b", 300, 0), arrow]);
    controller.select(["a", "b", "arr"]);
    controller.duplicateSelection();

    const copies = controller.selectedShapes();
    expect(copies).toHaveLength(3);
    const copyA = copies.find((s) => s.type === "rectangle" && s.x === 24);
    const copyArrow = copies.find((s) => s.type === "arrow");
    expect(copyA).toBeDefined();
    expect(copyArrow?.type === "arrow" && copyArrow.fromShapeId).toBe(copyA?.id);
  });

  it("copies and pastes at a point, and pastes plain text as a text shape", () => {
    const { controller, store } = setup();
    store.createShape(rect("a", 0, 0, 100, 50));
    controller.select(["a"]);
    const text = controller.copySelection();
    expect(text).not.toBeNull();

    expect(controller.paste(text ?? "", { x: 500, y: 500 })).toBe(true);
    const pasted = controller.selectedShapes()[0];
    expect(pasted).toMatchObject({ x: 450, y: 475, w: 100, h: 50 });
    expect(pasted?.id).not.toBe("a");

    expect(controller.paste("hello world", { x: 0, y: 0 })).toBe(true);
    const textShape = controller.selectedShapes()[0];
    expect(textShape?.type === "text" && textShape.text).toBe("hello world");
  });

  it("pastes an arrow bound to an uncopied shape as a free arrow at its drawn position", () => {
    const { controller, store } = setup();
    const arrow = createArrowShape(
      { start: { x: 0, y: 0 }, end: { x: 0, y: 0 }, fromShapeId: "a", toShapeId: "b" },
      { id: "arr", zIndex: "a3", userId: "t", now: 0 },
    );
    store.createShapes([rect("a", 0, 0), rect("b", 300, 0), arrow]);
    const drawn = resolveArrow(arrow, controller.lookup);
    controller.select(["arr"]);
    const text = controller.copySelection() ?? "";
    const payload = JSON.parse(text) as { shapes: { start: unknown; end: unknown }[] };
    expect(payload.shapes[0]).toMatchObject({ start: drawn.start, end: drawn.end });
  });

  it("aligns grouped shapes as one unit", () => {
    const { controller, store } = setup();
    store.createShapes([
      rect("a", 100, 0, 50, 50, { groupId: "g" }),
      rect("b", 200, 0, 50, 50, { groupId: "g" }),
      rect("c", 0, 100, 50, 50),
    ]);
    controller.select(["a", "c"]);
    controller.alignSelection("left");
    expect(store.getShape("a")?.x).toBe(0);
    expect(store.getShape("b")?.x).toBe(100);
    expect(store.getShape("c")?.x).toBe(0);
  });

  it("reorders the selection", () => {
    const { controller, store } = setup();
    store.createShapes([
      rect("a", 0, 0, 10, 10, { zIndex: "a0" }),
      rect("b", 0, 0, 10, 10, { zIndex: "a1" }),
    ]);
    controller.select(["a"]);
    controller.reorderSelection("front");
    expect(store.getSnapshot().ordered.map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("inserts a system shape to the right of the selection and connects it", () => {
    const { controller, store } = setup();
    store.createShape(box("client", { x: 0, y: 0, width: 160, height: 96 }, "client"));
    const id = controller.insertSystemShape("load_balancer", { x: 0, y: 0 }, "client");

    const lb = store.getShape(id);
    expect(lb?.type).toBe("load_balancer");
    expect(lb?.x).toBeGreaterThan(160);
    const arrow = store.getSnapshot().ordered.find((s) => s.type === "arrow");
    expect(arrow?.type === "arrow" && [arrow.fromShapeId, arrow.toShapeId]).toEqual(["client", id]);

    // One undo removes both the shape and its connecting arrow.
    controller.undo();
    expect(store.getSnapshot().ordered.map((s) => s.id)).toEqual(["client"]);
  });

  it("moves inserted shapes down past anything in the way", () => {
    const { controller, store } = setup();
    store.createShapes([
      box("client", { x: 0, y: 0, width: 160, height: 96 }, "client"),
      box("service", { x: 240, y: 0, width: 160, height: 96 }, "existing"),
    ]);
    const id = controller.insertSystemShape("service", { x: 0, y: 0 }, "client");
    expect(store.getShape(id)?.y).toBeGreaterThanOrEqual(96);
  });

  it("commits edited text, and removes a text shape emptied by editing", () => {
    const { controller, store } = setup();
    store.createShapes([
      box("service", { x: 0, y: 0, width: 160, height: 96 }, "s"),
      box("text", { x: 0, y: 200, width: 200, height: 28 }, "t"),
    ]);
    controller.startEditing("s");
    expect(controller.getUi().editingId).toBe("s");
    controller.commitText("s", "Orders API", null);
    expect(store.getShape("s")).toMatchObject({ label: "Orders API" });
    expect(controller.getUi().editingId).toBeNull();

    controller.commitText("t", "   ", null);
    expect(store.getShape("t")).toBeUndefined();
  });

  it("drops shapes removed by undo from the selection", () => {
    const { controller } = setup();
    controller.addShape(rect("r", 0, 0));
    controller.undo();
    expect(controller.getUi().selectedIds.size).toBe(0);
  });

  it("cycles through shapes with Tab order", () => {
    const { controller, store } = setup();
    store.createShapes([
      rect("a", 0, 0, 10, 10, { zIndex: "a0" }),
      rect("b", 0, 0, 10, 10, { zIndex: "a1" }),
    ]);
    controller.selectAdjacent(1);
    expect([...controller.getUi().selectedIds]).toEqual(["a"]);
    controller.selectAdjacent(1);
    expect([...controller.getUi().selectedIds]).toEqual(["b"]);
    controller.selectAdjacent(1);
    expect([...controller.getUi().selectedIds]).toEqual(["a"]);
  });

  it("ignores foreign clipboard payloads and empty text", () => {
    const { controller } = setup();
    expect(controller.paste("", { x: 0, y: 0 })).toBe(false);
    expect(controller.paste(serializeClipboard([]).replace("[]", "[1]"), null)).toBe(false);
  });
});
