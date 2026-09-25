import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { BoardReadOnlyError, BoardStore, BoardValidationError } from "../../src/board";
import { arrow, database, ids, rect } from "./fixtures";

function createStore() {
  return new BoardStore({ now: () => 1234 });
}

describe("BoardStore", () => {
  it("creates shapes and exposes them in render order", () => {
    const store = createStore();
    const top = rect({ zIndex: "a2" });
    const bottom = rect({ zIndex: "a1" });
    store.createShapes([top, bottom]);

    expect(ids(store.getSnapshot().ordered)).toEqual([bottom.id, top.id]);
    expect(store.getShape(top.id)).toEqual({ ...top, updatedAt: 1234 });
  });

  it("rejects invalid shapes without writing anything", () => {
    const store = createStore();
    const valid = rect();
    const invalid = rect({ w: -5 });
    expect(() => {
      store.createShapes([valid, invalid]);
    }).toThrow(BoardValidationError);
    expect(store.getSnapshot().ordered).toEqual([]);
  });

  it("rejects duplicate ids", () => {
    const store = createStore();
    const shape = rect();
    store.createShape(shape);
    expect(() => {
      store.createShape(shape);
    }).toThrow(/already exists/);
  });

  it("merges patches, including individual style keys", () => {
    const store = createStore();
    const shape = rect();
    store.createShape(shape);
    store.updateShape(shape.id, { x: 40, style: { fill: "#ff0000" } });

    const updated = store.getShape(shape.id);
    expect(updated).toMatchObject({ x: 40, y: 0, style: { fill: "#ff0000", stroke: "#1f2937" } });
  });

  it("validates patches before writing", () => {
    const store = createStore();
    const shape = database();
    store.createShape(shape);
    expect(() => {
      store.updateShape(shape.id, { engine: "graph" } as never);
    }).toThrow(BoardValidationError);
    expect(store.getShape(shape.id)?.type === "database" && store.getShape(shape.id)).toMatchObject(
      {
        engine: "sql",
      },
    );
  });

  it("keeps unchanged shapes referentially stable across snapshots", () => {
    const store = createStore();
    const a = rect();
    const b = rect();
    store.createShapes([a, b]);
    const before = store.getSnapshot();
    store.updateShape(a.id, { x: 10 });
    const after = store.getSnapshot();

    expect(after).not.toBe(before);
    expect(after.shapes.get(b.id)).toBe(before.shapes.get(b.id));
    expect(after.shapes.get(a.id)).not.toBe(before.shapes.get(a.id));
  });

  it("notifies subscribers once per transaction", () => {
    const store = createStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const a = rect();
    const b = rect();
    store.transact(() => {
      store.createShapes([a]);
      store.createShapes([b]);
      store.updateShape(a.id, { x: 5 });
    });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("deletes arrows bound to deleted shapes", () => {
    const store = createStore();
    const a = rect();
    const b = rect();
    const bound = arrow({ fromShapeId: a.id, toShapeId: b.id });
    const free = arrow();
    store.createShapes([a, b, bound, free]);

    store.deleteShapes([a.id]);

    expect(ids(store.getSnapshot().ordered).sort()).toEqual([b.id, free.id].sort());
  });

  it("reorders with fractional keys", () => {
    const store = createStore();
    const a = rect({ zIndex: "a0" });
    const b = rect({ zIndex: "a1" });
    const c = rect({ zIndex: "a2" });
    store.createShapes([a, b, c]);
    store.reorder([a.id], "front");
    expect(ids(store.getSnapshot().ordered)).toEqual([b.id, c.id, a.id]);
    expect(store.nextZIndex() > (store.getShape(a.id)?.zIndex ?? "")).toBe(true);
  });

  it("skips and reports invalid shapes arriving from another doc", () => {
    const onInvalidShape = vi.fn();
    const doc = new Y.Doc();
    const store = new BoardStore({ doc, onInvalidShape });
    const good = rect();
    store.createShape(good);

    // Simulate a malformed shape written by another client.
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    const bad = new Y.Map<unknown>();
    bad.set("id", "bad");
    bad.set("type", "rectangle");
    remote.getMap("shapes").set("bad", bad);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote), "remote");

    expect(ids(store.getSnapshot().ordered)).toEqual([good.id]);
    expect(onInvalidShape).toHaveBeenCalledWith("bad", expect.any(BoardValidationError));
  });

  it("loads existing shapes from a pre-populated doc", () => {
    const source = createStore();
    const shape = rect();
    source.createShape(shape);
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(source.doc));

    expect(new BoardStore({ doc: copy }).getShape(shape.id)).toMatchObject({ id: shape.id });
  });
});

describe("BoardStore view-only mode", () => {
  it("refuses local writes but still receives remote changes", () => {
    const store = new BoardStore();
    const shape = rect();
    store.createShape(shape);
    store.readOnly = true;
    expect(() => {
      store.updateShape(shape.id, { x: 5 });
    }).toThrow(BoardReadOnlyError);
    expect(() => {
      store.createShape(rect());
    }).toThrow(BoardReadOnlyError);
    expect(() => {
      store.deleteShapes([shape.id]);
    }).toThrow(BoardReadOnlyError);

    const remote = new BoardStore();
    Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(store.doc));
    remote.updateShape(shape.id, { x: 99 });
    Y.applyUpdate(store.doc, Y.encodeStateAsUpdate(remote.doc), "remote");
    expect(store.getShape(shape.id)?.x).toBe(99);
  });

  it("writes nothing to the document until the first local edit", () => {
    // A viewer opening a board must not create updates (the server would drop them and the
    // board would look unsaved forever); editors shouldn't send one on every open either.
    const doc = new Y.Doc();
    const onUpdate = vi.fn();
    doc.on("update", onUpdate);
    const store = new BoardStore({ doc });
    expect(onUpdate).not.toHaveBeenCalled();

    store.createShape(rect());
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(doc.getMap("meta").get("schemaVersion")).toBeTypeOf("number");
  });
});
