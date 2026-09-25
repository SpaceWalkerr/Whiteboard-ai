import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BoardHistory, BoardStore } from "../../src/board";
import { rect } from "./fixtures";

function setup() {
  const store = new BoardStore();
  const history = new BoardHistory(store, { captureTimeout: 0 });
  return { store, history };
}

describe("BoardHistory", () => {
  it("undoes and redoes a creation", () => {
    const { store, history } = setup();
    const shape = rect();
    store.createShape(shape);

    history.undo();
    expect(store.getShape(shape.id)).toBeUndefined();
    history.redo();
    expect(store.getShape(shape.id)).toBeDefined();
  });

  it("restores the previous position after a move", () => {
    const { store, history } = setup();
    const shape = rect({ x: 10 });
    store.createShape(shape);
    history.stopCapturing();
    store.updateShape(shape.id, { x: 200 });

    history.undo();
    expect(store.getShape(shape.id)?.x).toBe(10);
  });

  it("undoes a whole gesture as one step", () => {
    const store = new BoardStore();
    const history = new BoardHistory(store, { captureTimeout: 10_000 });
    const shape = rect({ x: 0 });
    store.createShape(shape);
    history.stopCapturing();

    // A drag: many updates between gesture boundaries.
    for (let x = 1; x <= 20; x++) store.updateShape(shape.id, { x });
    history.stopCapturing();

    history.undo();
    expect(store.getShape(shape.id)?.x).toBe(0);
  });

  it("groups everything inside runAsSingleStep", () => {
    const { store, history } = setup();
    const a = rect();
    const b = rect();
    history.runAsSingleStep(() => {
      store.createShape(a);
      store.createShape(b);
    });
    history.undo();
    expect(store.getSnapshot().ordered).toEqual([]);
  });

  it("never undoes changes that came from another client", () => {
    const { store, history } = setup();
    const mine = rect({ x: 1 });
    store.createShape(mine);

    const remote = new BoardStore();
    Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(store.doc));
    const theirs = rect();
    remote.createShape(theirs);
    Y.applyUpdate(store.doc, Y.encodeStateAsUpdate(remote.doc), "remote");

    history.undo();
    expect(store.getShape(mine.id)).toBeUndefined();
    expect(store.getShape(theirs.id)).toBeDefined();
  });

  it("reports whether undo and redo are available", () => {
    const { store, history } = setup();
    expect(history.getState()).toEqual({ canUndo: false, canRedo: false });
    store.createShape(rect());
    expect(history.getState()).toEqual({ canUndo: true, canRedo: false });
    history.undo();
    expect(history.getState()).toEqual({ canUndo: false, canRedo: true });
  });
});

describe("BoardHistory steps", () => {
  it("keeps a long gesture in one step even with pauses", async () => {
    const store = new BoardStore();
    const history = new BoardHistory(store, { captureTimeout: 1 });
    const shape = rect({ x: 0 });
    store.createShape(shape);

    history.beginStep();
    store.updateShape(shape.id, { x: 10 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    store.updateShape(shape.id, { x: 20 });
    history.endStep();

    history.undo();
    expect(store.getShape(shape.id)?.x).toBe(0);
  });
});
