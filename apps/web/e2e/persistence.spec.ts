import { expect, test, type Page } from "@playwright/test";
import { insertShape, openBoard, shapes } from "./helpers";

function saved(page: Page) {
  return page.waitForFunction(() => window.__whiteboard?.saveState() === "saved");
}

function types(page: Page) {
  return shapes(page).then((all) => all.map((s) => s.type).sort());
}

test.describe("persistence and offline", () => {
  test("shows Saving… then Saved once the server has committed the edit", async ({ page }) => {
    await openBoard(page);
    await insertShape(page, "service");
    await saved(page);
    await expect(page.locator('[data-save-state="saved"]')).toHaveText("Saved");
  });

  test("edits made offline survive closing the tab and sync when reopened online", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await openBoard(page);
    const url = page.url();
    await insertShape(page, "client");
    await saved(page);

    await context.setOffline(true);
    await expect(page.getByRole("alert")).toContainText(
      "You're offline — changes are saved on this device",
    );
    await insertShape(page, "database");
    expect(await page.evaluate(() => window.__whiteboard?.saveState())).toBe("saving");
    // Let y-indexeddb write, then close the tab while still offline.
    await page.waitForTimeout(300);
    await page.close();

    await context.setOffline(false);
    const reopened = await context.newPage();
    await openBoard(reopened, url);
    // Quick insert connects the new database from the selected client, hence the arrow.
    await expect.poll(() => types(reopened)).toEqual(["arrow", "client", "database"]);
    await saved(reopened);

    // Someone else (no local cache) sees the offline edit: it reached the server.
    const other = await (await browser.newContext()).newPage();
    await openBoard(other, url);
    await expect.poll(() => types(other)).toEqual(["arrow", "client", "database"]);
  });

  test("a board opens with no network from the cached app and local copy", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await openBoard(page);
    const url = page.url();
    await insertShape(page, "cache");
    await saved(page);
    // The service worker must be installed and controlling the page before going offline.
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

    await context.setOffline(true);
    await page.goto(url);
    await expect(page.getByRole("main", { name: /Whiteboard canvas/ })).toBeVisible();
    await expect.poll(() => types(page)).toEqual(["cache"]);
    await expect(page.getByRole("alert")).toContainText("You're offline");
    await context.setOffline(false);
  });

  test("a 2,000-shape board loads in under 1.5 s", async ({ browser }) => {
    const author = await (await browser.newContext()).newPage();
    await openBoard(author);
    const url = author.url();
    expect(await author.evaluate(() => window.__whiteboard?.seed(2000))).toBe(2000);
    await author.waitForFunction(() => window.__whiteboard?.saveState() === "saved", undefined, {
      timeout: 30_000,
    });

    // A fresh browser (no local cache) opening the board.
    const reader = await (await browser.newContext()).newPage();
    const started = Date.now();
    await reader.goto(url);
    await reader.waitForFunction(
      () => (window.__whiteboard?.shapes().length ?? 0) === 2000,
      undefined,
      { timeout: 10_000 },
    );
    // Wait for the frame that draws them.
    await reader.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const elapsed = Date.now() - started;
    test.info().annotations.push({
      type: "perf",
      description: `2,000-shape board loaded and drawn in ${elapsed} ms`,
    });
    process.stdout.write(`[perf] 2,000-shape board loaded and drawn in ${elapsed} ms\n`);
    expect(elapsed).toBeLessThan(1500);
  });
});
