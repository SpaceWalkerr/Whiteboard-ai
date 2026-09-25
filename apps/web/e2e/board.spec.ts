import { expect, test } from "@playwright/test";
import { isOnOutline, resolveArrow } from "../src/features/board/geometry/arrow";
import { arrows, center, drag, modKey, openBoard, shapes, toScreen } from "./helpers";

test.describe("board", () => {
  test("arrows stay attached when a shape moves, and undo restores the position", async ({
    page,
  }) => {
    await openBoard(page);
    const canvas = await page.getByRole("main", { name: /Whiteboard canvas/ }).boundingBox();
    if (!canvas) throw new Error("canvas not visible");

    await page.getByRole("button", { name: "Service", exact: true }).click();
    await page.mouse.click(canvas.x + 400, canvas.y + 300);
    await page.getByRole("button", { name: "Database", exact: true }).click();
    await page.mouse.click(canvas.x + 800, canvas.y + 300);

    const created = await shapes(page);
    const service = created.find((s) => s.type === "service");
    const database = created.find((s) => s.type === "database");
    if (!service || !database) throw new Error("shapes were not created");

    await page.keyboard.press("a");
    await drag(page, await toScreen(page, center(service)), await toScreen(page, center(database)));

    const [arrow] = await arrows(page);
    expect(arrow).toMatchObject({ fromShapeId: service.id, toShapeId: database.id });
    if (!arrow) throw new Error("arrow was not created");

    // Move the service well below its original position.
    const from = await toScreen(page, center(service));
    await drag(page, from, { x: from.x + 40, y: from.y + 260 });

    const afterMove = await shapes(page);
    const movedService = afterMove.find((s) => s.id === service.id);
    const currentArrow = afterMove.find((s) => s.id === arrow.id);
    if (!movedService || currentArrow?.type !== "arrow")
      throw new Error("shapes missing after move");
    expect(movedService.y).toBeGreaterThan(service.y + 200);

    const lookup = (id: string) => afterMove.find((s) => s.id === id);
    const geometry = resolveArrow(currentArrow, lookup);
    expect(isOnOutline(movedService, geometry.start)).toBe(true);
    expect(isOnOutline(database, geometry.end)).toBe(true);
    // The hook reports what the canvas renders: same geometry.
    expect(await page.evaluate((id) => window.__whiteboard?.arrowGeometry(id), arrow.id)).toEqual(
      geometry,
    );

    await page.keyboard.press(`${await modKey(page)}+z`);
    const afterUndo = await shapes(page);
    expect(afterUndo.find((s) => s.id === service.id)).toMatchObject({
      x: service.x,
      y: service.y,
    });
    const undoArrow = afterUndo.find((s) => s.id === arrow.id);
    if (undoArrow?.type !== "arrow") throw new Error("arrow missing after undo");
    const undoGeometry = resolveArrow(undoArrow, (id) => afterUndo.find((s) => s.id === id));
    expect(isOnOutline(service, undoGeometry.start)).toBe(true);
  });

  test("builds client → LB → 2 services → DB + cache with the keyboard only", async ({ page }) => {
    await openBoard(page);
    const insert = async (query: string) => {
      await page.keyboard.press("/");
      const input = page.getByRole("combobox", { name: "Shape name" });
      await expect(input).toBeFocused();
      await input.fill(query);
      await page.keyboard.press("Enter");
      await expect(input).toBeHidden();
    };

    // Nothing selected: the client lands in the middle of the screen.
    await insert("client");
    await insert("lb");
    await insert("service");
    await insert("database");
    // Select the load balancer (Tab cycles shapes), then branch a second service off it.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await insert("service");
    await insert("cache");

    const all = await shapes(page);
    const types = all
      .filter((s) => s.type !== "arrow")
      .map((s) => s.type)
      .sort();
    expect(types).toEqual(["cache", "client", "database", "load_balancer", "service", "service"]);

    const byId = new Map(all.map((s) => [s.id, s.type]));
    const edges = (await arrows(page))
      .map((a) => `${byId.get(a.fromShapeId ?? "")}->${byId.get(a.toShapeId ?? "")}`)
      .sort();
    expect(edges).toEqual([
      "client->load_balancer",
      "load_balancer->service",
      "load_balancer->service",
      "service->cache",
      "service->database",
    ]);
  });

  test("'?' opens the keyboard shortcut cheat sheet", async ({ page }) => {
    await openBoard(page);
    await page.keyboard.press("?");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  test("exports the board as PNG and SVG", async ({ page }) => {
    await openBoard(page);
    await page.keyboard.press("/");
    await page.getByRole("combobox", { name: "Shape name" }).fill("service");
    await page.keyboard.press("Enter");

    for (const [item, extension] of [
      ["Export as PNG", ".png"],
      ["Export as SVG", ".svg"],
    ] as const) {
      await page.getByRole("button", { name: "Export" }).click();
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("menuitem", { name: item }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe(`board${extension}`);
    }
  });
});
