import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { BoardStore } from "@whiteboard/shared/board";
import { attachLocalCache } from "../sync/localCache";
import { rect } from "./fixtures";

async function waitFor(condition: () => boolean): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > 3000) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("local IndexedDB cache", () => {
  it("restores a board's shapes in a new session (e.g. after closing the tab offline)", async () => {
    const boardId = crypto.randomUUID();
    const first = new BoardStore();
    const detachFirst = attachLocalCache(first, boardId);
    first.createShape(rect("offline-edit", 10, 20));
    // Give y-indexeddb a moment to write.
    await new Promise((resolve) => setTimeout(resolve, 100));
    detachFirst();

    const second = new BoardStore();
    const detachSecond = attachLocalCache(second, boardId);
    await waitFor(() => second.getShape("offline-edit") !== undefined);
    expect(second.getShape("offline-edit")).toMatchObject({ x: 10, y: 20 });
    detachSecond();
  });

  it("keeps boards separate", async () => {
    const a = new BoardStore();
    const detachA = attachLocalCache(a, crypto.randomUUID());
    a.createShape(rect("only-in-a", 0, 0));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const b = new BoardStore();
    const detachB = attachLocalCache(b, crypto.randomUUID());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(b.getShape("only-in-a")).toBeUndefined();
    detachA();
    detachB();
  });
});
