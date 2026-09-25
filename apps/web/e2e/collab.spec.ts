import { expect, test, type Browser, type Page } from "@playwright/test";
import { center, drag, insertShape, openBoard, shapes, toScreen } from "./helpers";

/** Two separate browser contexts = two different people (separate storage, separate guests). */
async function twoUsers(browser: Browser): Promise<{ a: Page; b: Page }> {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await openBoard(a);
  await openBoard(b, a.url());
  return { a, b };
}

function types(page: Page) {
  return shapes(page).then((all) => all.map((s) => s.type).sort());
}

test.describe("real-time collaboration", () => {
  test("a shape drawn by A appears for B, and B's move appears for A", async ({ browser }) => {
    const { a, b } = await twoUsers(browser);

    await insertShape(a, "service");
    await expect.poll(() => types(b)).toEqual(["service"]);

    const [service] = await shapes(b);
    if (!service) throw new Error("shape missing");
    const from = await toScreen(b, center(service));
    await drag(b, from, { x: from.x + 220, y: from.y + 140 });

    const movedOnB = (await shapes(b))[0];
    expect(movedOnB?.x).toBeGreaterThan(service.x + 150);
    await expect.poll(async () => (await shapes(a))[0]?.x).toBe(movedOnB?.x);
    await expect.poll(async () => (await shapes(a))[0]?.y).toBe(movedOnB?.y);
  });

  test("each user sees the other's named cursor and presence avatar", async ({ browser }) => {
    const { a, b } = await twoUsers(browser);
    const nameA = await a.evaluate(() => window.__whiteboard?.me().name ?? "");
    const nameB = await b.evaluate(() => window.__whiteboard?.me().name ?? "");

    const canvasA = await a.getByRole("main", { name: /Whiteboard canvas/ }).boundingBox();
    const canvasB = await b.getByRole("main", { name: /Whiteboard canvas/ }).boundingBox();
    if (!canvasA || !canvasB) throw new Error("canvas not visible");
    await a.mouse.move(canvasA.x + 500, canvasA.y + 400);
    await a.mouse.move(canvasA.x + 520, canvasA.y + 410);
    await b.mouse.move(canvasB.x + 600, canvasB.y + 300);
    await b.mouse.move(canvasB.x + 610, canvasB.y + 310);

    await expect(b.locator(`[data-remote-cursor="${nameA}"]`)).toBeVisible();
    await expect(a.locator(`[data-remote-cursor="${nameB}"]`)).toBeVisible();
    await expect(b.getByRole("button", { name: `Follow ${nameA}` })).toBeVisible();

    // The avatar shows the connection is live.
    await expect(a.getByRole("status").filter({ hasText: "Live" })).toBeVisible();
  });

  test("edits made while offline merge when the connection returns", async ({ browser }) => {
    const { a, b } = await twoUsers(browser);

    await a.context().setOffline(true);
    await expect(a.getByText("Offline — changes will sync when you reconnect")).toBeVisible();

    await insertShape(a, "cache");
    await insertShape(b, "database");
    // Not yet shared.
    expect(await types(a)).toEqual(["cache"]);
    expect(await types(b)).toEqual(["database"]);

    await a.context().setOffline(false);
    await expect.poll(() => types(a)).toEqual(["cache", "database"]);
    await expect.poll(() => types(b)).toEqual(["cache", "database"]);
  });

  test("following another user moves my viewport with theirs", async ({ browser }) => {
    const { a, b } = await twoUsers(browser);
    const nameA = await a.evaluate(() => window.__whiteboard?.me().name ?? "");

    await b.getByRole("button", { name: `Follow ${nameA}` }).click();
    await expect(b.getByText(`Following ${nameA}`)).toBeVisible();

    await a.evaluate(() => {
      window.__whiteboard?.setViewport({ x: -1000, y: -500, scale: 0.5 });
    });
    await expect
      .poll(async () => (await b.evaluate(() => window.__whiteboard?.viewport()))?.scale)
      .toBe(0.5);

    // Escape stops following.
    await b.keyboard.press("Escape");
    await expect(b.getByText(`Following ${nameA}`)).toBeHidden();
  });
});
