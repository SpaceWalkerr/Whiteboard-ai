import { expect, test, type Page } from "@playwright/test";
import { deleteE2EUsers } from "./auth";
import { arrows, center, drag, openBoard, shapes, toScreen } from "./helpers";

test.afterAll(async () => {
  await deleteE2EUsers();
});

async function place(page: Page, shapeName: string, x: number, y: number): Promise<string> {
  const canvas = await page.getByRole("main", { name: /Whiteboard canvas/ }).boundingBox();
  if (!canvas) throw new Error("canvas not visible");
  const before = new Set((await shapes(page)).map((s) => s.id));
  await page.getByRole("button", { name: shapeName, exact: true }).click();
  await page.mouse.click(canvas.x + x, canvas.y + y);
  const created = (await shapes(page)).find((s) => !before.has(s.id));
  if (!created) throw new Error(`${shapeName} was not created`);
  return created.id;
}

async function connect(page: Page, fromId: string, toId: string): Promise<string> {
  const all = await shapes(page);
  const from = all.find((s) => s.id === fromId);
  const to = all.find((s) => s.id === toId);
  if (!from || !to) throw new Error("shapes missing");
  const before = new Set((await arrows(page)).map((a) => a.id));
  await page.keyboard.press("a");
  await drag(page, await toScreen(page, center(from)), await toScreen(page, center(to)));
  const arrow = (await arrows(page)).find((a) => !before.has(a.id));
  expect(arrow).toMatchObject({ fromShapeId: fromId, toShapeId: toId });
  if (!arrow) throw new Error("arrow was not created");
  return arrow.id;
}

async function chooseOption(page: Page, field: string, option: string): Promise<void> {
  await page.getByRole("combobox", { name: field }).click();
  await page.getByRole("option", { name: option }).click();
}

test.describe("design check", () => {
  test("a single database is a critical SPOF that highlights it; adding a replica fixes it", async ({
    page,
  }) => {
    await openBoard(page);
    const service = await place(page, "Service", 400, 300);
    const db = await place(page, "Database", 800, 300);
    await connect(page, service, db);

    // Move the view far away so zooming to the finding is observable.
    await page.evaluate(() => {
      window.__whiteboard?.setViewport({ x: -4000, y: -4000, scale: 0.5 });
    });

    await page.getByRole("button", { name: "Check design" }).click();
    const panel = page.getByRole("complementary", { name: "Design check" });
    await expect(panel).toBeVisible();
    const finding = panel.getByRole("button", { name: /has no replica/ });
    await expect(finding).toContainText("Critical");

    await finding.click();
    await expect(finding).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => window.__whiteboard?.designCheckFocus())).toEqual([db]);
    // Zoomed to the database: its centre is on screen, clear of the panels.
    const dbShape = (await shapes(page)).find((s) => s.id === db);
    if (!dbShape) throw new Error("database missing");
    const onScreen = await toScreen(page, center(dbShape));
    const canvas = await page.getByRole("main", { name: /Whiteboard canvas/ }).boundingBox();
    if (!canvas) throw new Error("canvas not visible");
    expect(onScreen.x).toBeGreaterThan(canvas.x + 110);
    expect(onScreen.x).toBeLessThan(canvas.x + canvas.width - 350);
    expect(onScreen.y).toBeGreaterThan(canvas.y + 70);
    expect(onScreen.y).toBeLessThan(canvas.y + canvas.height - 70);
    expect((await page.evaluate(() => window.__whiteboard?.viewport()))?.scale).toBe(1.25);

    // Fix the design: a replica, connected with a replication arrow.
    const replica = await place(page, "Database", 700, 650);
    await chooseOption(page, "Role", "Replica");
    await connect(page, db, replica);
    await chooseOption(page, "Connection type", "Replication");
    expect((await arrows(page)).find((a) => a.toShapeId === replica)?.edgeType).toBe("replication");

    await expect(panel.getByText("The board changed since this check.")).toBeVisible();
    await panel.getByRole("button", { name: "Re-check", exact: true }).click();
    await expect(panel.getByRole("button", { name: /has no replica/ })).toHaveCount(0);
    const result = await page.evaluate(() => window.__whiteboard?.designCheck());
    expect(result?.findings.filter((f) => f.ruleId === "db-spof")).toEqual([]);
    // The fixed finding's highlight is gone too.
    expect(await page.evaluate(() => window.__whiteboard?.designCheckFocus())).toBeNull();

    // Shift+C re-runs the check from the keyboard; Escape inside the panel closes it.
    await page.getByRole("heading", { name: "Design check" }).focus();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(page.getByRole("button", { name: "Check design" })).toBeFocused();
    await page.keyboard.press("Shift+C");
    await expect(panel).toBeVisible();
  });
});
