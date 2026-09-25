import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PropertiesPanel } from "../ui/PropertiesPanel";
import { QuickInsertDialog } from "../ui/QuickInsertDialog";
import { ShortcutsDialog } from "../ui/ShortcutsDialog";
import { box, rect, setup } from "./fixtures";

describe("PropertiesPanel", () => {
  function renderPanel() {
    const ctx = setup();
    render(
      <TooltipProvider>
        <PropertiesPanel controller={ctx.controller} />
      </TooltipProvider>,
    );
    return ctx;
  }

  it("is hidden when nothing is selected", () => {
    renderPanel();
    expect(screen.queryByRole("complementary", { name: "Shape properties" })).toBeNull();
  });

  it("renames the selected shape when the label is committed", async () => {
    const { controller, store } = renderPanel();
    act(() => {
      store.createShape(box("service", { x: 0, y: 0, width: 160, height: 96 }, "s"));
      controller.select(["s"]);
    });
    const input = screen.getByLabelText("Label");
    await userEvent.clear(input);
    await userEvent.type(input, "Orders API{Enter}");
    expect(store.getShape("s")).toMatchObject({ label: "Orders API" });
  });

  it("applies a stroke colour to every selected shape as one undo step", async () => {
    const { controller, store } = renderPanel();
    act(() => {
      store.createShapes([rect("a", 0, 0), rect("b", 200, 0)]);
      controller.select(["a", "b"]);
    });
    expect(screen.getByRole("heading", { name: "2 shapes" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Stroke: Blue" }));
    expect(store.getShape("a")?.style.stroke).toBe("#1d4ed8");
    expect(store.getShape("b")?.style.stroke).toBe("#1d4ed8");

    act(() => {
      controller.undo();
    });
    expect(store.getShape("a")?.style.stroke).toBe("#1f2937");
  });

  it("offers alignment only for two or more shapes", () => {
    const { controller, store } = renderPanel();
    act(() => {
      store.createShapes([rect("a", 0, 0), rect("b", 200, 0)]);
      controller.select(["a"]);
    });
    expect(screen.queryByRole("button", { name: "Align left" })).toBeNull();
    act(() => {
      controller.select(["a", "b"]);
    });
    expect(screen.getByRole("button", { name: "Align left" })).toBeVisible();
  });
});

describe("ShortcutsDialog", () => {
  it("lists shortcuts by group with platform-specific keys", () => {
    render(<ShortcutsDialog open onOpenChange={vi.fn()} mac />);
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    for (const group of ["Tools", "Edit", "Arrange", "View"]) {
      expect(screen.getByRole("heading", { name: group })).toBeVisible();
    }
    expect(screen.getAllByText("⌘").length).toBeGreaterThan(0);
  });
});

describe("QuickInsertDialog", () => {
  it("inserts the highlighted match on Enter, connected by default", async () => {
    const onInsert = vi.fn();
    render(
      <QuickInsertDialog
        open
        onOpenChange={vi.fn()}
        connectFromLabel="Client"
        onInsert={onInsert}
      />,
    );
    await userEvent.type(screen.getByRole("combobox", { name: "Shape name" }), "lb{Enter}");
    expect(onInsert).toHaveBeenCalledWith("load_balancer", true);
  });

  it("can insert without connecting", async () => {
    const onInsert = vi.fn();
    render(
      <QuickInsertDialog
        open
        onOpenChange={vi.fn()}
        connectFromLabel="Client"
        onInsert={onInsert}
      />,
    );
    await userEvent.click(screen.getByLabelText("Connect from “Client”"));
    await userEvent.type(screen.getByRole("combobox", { name: "Shape name" }), "cache{Enter}");
    expect(onInsert).toHaveBeenCalledWith("cache", false);
  });

  it("moves through results with the arrow keys", async () => {
    const onInsert = vi.fn();
    render(
      <QuickInsertDialog open onOpenChange={vi.fn()} connectFromLabel={null} onInsert={onInsert} />,
    );
    await userEvent.type(
      screen.getByRole("combobox", { name: "Shape name" }),
      "{ArrowDown}{Enter}",
    );
    expect(onInsert).toHaveBeenCalledWith("cdn", false);
  });
});
