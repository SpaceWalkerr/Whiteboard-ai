import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Shape } from "@whiteboard/shared/board";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DesignCheckStore, type CheckFocus } from "../check/DesignCheckStore";
import { matchShortcut, type KeyInput } from "../keyboard/shortcuts";
import { createArrowShape } from "../model/defaults";
import { FindingsPanel } from "../ui/FindingsPanel";
import { zoomToShapes } from "../viewport/zoomActions";
import { box, rect, setup } from "./fixtures";

function arrow(id: string, from: string, to: string, extra: Record<string, unknown> = {}): Shape {
  return {
    ...createArrowShape(
      { start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, fromShapeId: from, toShapeId: to },
      { id, zIndex: "a0", userId: "test", now: 0 },
    ),
    ...extra,
  };
}

/** Client → API → a single primary database. */
function singleDbBoard(): Shape[] {
  return [
    box("client", { x: 0, y: 0, width: 120, height: 80 }, "app", { label: "Web app" }),
    box("service", { x: 200, y: 0, width: 120, height: 80 }, "api", { label: "API" }),
    box("database", { x: 400, y: 0, width: 120, height: 80 }, "db", { label: "Postgres" }),
    arrow("a1", "app", "api"),
    arrow("a2", "api", "db"),
  ];
}

describe("DesignCheckStore", () => {
  it("checks the current board and reports the single database as a critical SPOF", () => {
    const { store } = setup();
    store.createShapes(singleDbBoard());
    const check = new DesignCheckStore(store);
    const result = check.run();
    expect(check.get().open).toBe(true);
    const spof = result.findings.find((f) => f.ruleId === "db-spof");
    expect(spof).toMatchObject({ severity: "critical", shapeIds: ["db"] });
  });

  it("is stale after the board changes, and fresh again after a re-check", () => {
    const { store } = setup();
    store.createShapes(singleDbBoard());
    const check = new DesignCheckStore(store);
    check.run();
    expect(check.isStale(store.getSnapshot())).toBe(false);
    store.createShape(rect("note", 0, 300));
    expect(check.isStale(store.getSnapshot())).toBe(true);
    check.run();
    expect(check.isStale(store.getSnapshot())).toBe(false);
  });

  it("drops the highlight on re-check when the finding is fixed, keeps it otherwise", () => {
    const { store } = setup();
    store.createShapes(singleDbBoard());
    const check = new DesignCheckStore(store);
    const spof = check.run().findings.find((f) => f.ruleId === "db-spof");
    if (!spof) throw new Error("expected a SPOF finding");
    const focus: CheckFocus = { key: spof.id, shapeIds: spof.shapeIds, tone: spof.severity };
    check.setFocus(focus);

    check.run();
    expect(check.get().focus).toEqual(focus);

    store.createShapes([
      box("database", { x: 400, y: 200, width: 120, height: 80 }, "replica", {
        label: "Replica",
        role: "replica",
      }),
      arrow("r", "db", "replica", { edgeType: "replication" }),
    ]);
    const after = check.run();
    expect(after.findings.some((f) => f.ruleId === "db-spof")).toBe(false);
    expect(check.get().focus).toBeNull();
  });

  it("closing hides the panel and clears the highlight", () => {
    const { store } = setup();
    const check = new DesignCheckStore(store);
    check.run();
    check.setFocus({ key: "x", shapeIds: ["x"], tone: "info" });
    check.close();
    expect(check.get()).toMatchObject({ open: false, focus: null });
  });
});

describe("FindingsPanel", () => {
  function renderPanel(shapes: Shape[]) {
    const ctx = setup();
    ctx.store.createShapes(shapes);
    const check = new DesignCheckStore(ctx.store);
    check.run();
    const onFocus = vi.fn((focus: CheckFocus) => {
      check.setFocus(focus);
    });
    const onClose = vi.fn();
    const onRecheck = vi.fn(() => {
      check.run();
    });
    render(
      <TooltipProvider>
        <FindingsPanel
          check={check}
          store={ctx.store}
          onFocus={onFocus}
          onClose={onClose}
          onRecheck={onRecheck}
        />
      </TooltipProvider>,
    );
    return { ...ctx, check, onFocus, onClose, onRecheck };
  }

  it("lists findings with a text severity, explanation and fix, and focuses the heading", () => {
    renderPanel(singleDbBoard());
    const panel = screen.getByRole("complementary", { name: "Design check" });
    expect(screen.getByRole("heading", { name: "Design check" })).toHaveFocus();
    const list = within(panel).getByRole("list", { name: "Findings" });
    const spof = within(list).getByRole("button", { name: /Postgres” has no replica/ });
    expect(spof).toHaveTextContent("Critical");
    expect(spof).toHaveTextContent("Fix:");
    expect(spof).toHaveAttribute("aria-pressed", "false");
    expect(within(panel).getByText("1 critical", { selector: "p" })).toBeVisible();
  });

  it("clicking a finding focuses its shapes", async () => {
    const { onFocus } = renderPanel(singleDbBoard());
    const spof = screen.getByRole("button", { name: /has no replica/ });
    await userEvent.click(spof);
    expect(onFocus).toHaveBeenCalledWith({
      key: "db-spof:db",
      shapeIds: ["db"],
      tone: "critical",
    });
    expect(spof).toHaveAttribute("aria-pressed", "true");
  });

  it("works from the keyboard", async () => {
    const { onFocus } = renderPanel(singleDbBoard());
    await userEvent.tab(); // Re-check
    await userEvent.tab(); // Close
    await userEvent.tab(); // First finding
    await userEvent.keyboard("{Enter}");
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape without it reaching the board", async () => {
    const boardEscape = vi.fn();
    window.addEventListener("keydown", boardEscape);
    const { onClose } = renderPanel(singleDbBoard());
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(boardEscape).not.toHaveBeenCalled();
    window.removeEventListener("keydown", boardEscape);
  });

  it("says when nothing was found", () => {
    renderPanel([
      box("client", { x: 0, y: 0, width: 120, height: 80 }, "app"),
      box("service", { x: 200, y: 0, width: 120, height: 80 }, "api"),
      arrow("a", "app", "api"),
    ]);
    expect(screen.getByText("No obvious problems found")).toBeVisible();
    expect(screen.queryByRole("list", { name: "Findings" })).toBeNull();
  });

  it("reports shapes that weren't checked, and can focus them", async () => {
    const { onFocus } = renderPanel([
      ...singleDbBoard(),
      rect("frame", 0, 300, 100, 50, { label: "Redis?" }),
    ]);
    await userEvent.click(screen.getByText("1 shape not checked"));
    const item = screen.getByRole("button", { name: /Rectangle “Redis\?”/ });
    expect(item).toHaveTextContent("Not a system component");
    await userEvent.click(item);
    expect(onFocus).toHaveBeenCalledWith({
      key: "ignored:frame",
      shapeIds: ["frame"],
      tone: "info",
    });
  });

  it("shows when results are stale and re-checks on request", async () => {
    const { store, onRecheck } = renderPanel(singleDbBoard());
    expect(screen.queryByText("The board changed since this check.")).toBeNull();
    act(() => {
      store.createShapes([
        box("database", { x: 400, y: 200, width: 120, height: 80 }, "replica", {
          role: "replica",
        }),
        arrow("r", "db", "replica", { edgeType: "replication" }),
      ]);
    });
    expect(screen.getByText("The board changed since this check.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Re-check" }));
    expect(onRecheck).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("The board changed since this check.")).toBeNull();
    expect(screen.queryByRole("button", { name: /has no replica/ })).toBeNull();
  });
});

describe("zoomToShapes", () => {
  it("fits the given shapes into the area left by the panels, capped at 125%", () => {
    const { store, viewport } = setup();
    store.createShapes([rect("a", 1000, 1000, 100, 50), rect("far", -5000, -5000)]);
    const inset = { left: 100, right: 300, top: 100, bottom: 100 };
    expect(zoomToShapes(store, viewport, ["a"], inset)).toBe(true);
    const vp = viewport.get();
    expect(vp.scale).toBe(1.25);
    // The shape's centre lands in the centre of the free area (1000×800 screen).
    const centre = { x: 1050 * vp.scale + vp.x, y: 1025 * vp.scale + vp.y };
    expect(centre.x).toBeCloseTo(100 + (1000 - 400) / 2);
    expect(centre.y).toBeCloseTo(100 + (800 - 200) / 2);
  });

  it("zooms out to fit shapes far apart, and ignores unknown ids", () => {
    const { store, viewport } = setup();
    store.createShapes([rect("a", 0, 0), rect("b", 4000, 0)]);
    expect(zoomToShapes(store, viewport, ["a", "b", "gone"])).toBe(true);
    expect(viewport.get().scale).toBeLessThan(0.3);
    expect(zoomToShapes(store, viewport, ["gone"])).toBe(false);
  });
});

describe("Check design shortcut", () => {
  const key = (k: string, shiftKey: boolean): KeyInput => ({
    key: k,
    code: "KeyC",
    metaKey: false,
    ctrlKey: false,
    shiftKey,
    altKey: false,
  });

  it("is Shift+C, and plain C does nothing", () => {
    expect(matchShortcut(key("C", true), true)).toBe("checkDesign");
    expect(matchShortcut(key("c", false), true)).toBeNull();
  });
});
