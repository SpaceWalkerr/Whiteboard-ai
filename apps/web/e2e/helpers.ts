import { expect, type Page } from "@playwright/test";
import type { ArrowShape, Shape } from "@whiteboard/shared/board";

export interface Point {
  x: number;
  y: number;
}

/** Opens a new board (or `url`) and waits until it is connected to the sync server. */
export async function openBoard(page: Page, url = "/board/local"): Promise<void> {
  await page.goto(url);
  await expect(page.getByRole("main", { name: /Whiteboard canvas/ })).toBeVisible();
  await page.waitForFunction(() => window.__whiteboard?.status() === "connected");
}

export async function insertShape(page: Page, query: string): Promise<void> {
  await page.keyboard.press("/");
  const input = page.getByRole("combobox", { name: "Shape name" });
  await expect(input).toBeFocused();
  await input.fill(query);
  await page.keyboard.press("Enter");
  await expect(input).toBeHidden();
}

export function shapes(page: Page): Promise<Shape[]> {
  return page.evaluate(() => window.__whiteboard?.shapes() ?? []) as Promise<Shape[]>;
}

export async function arrows(page: Page): Promise<ArrowShape[]> {
  return (await shapes(page)).filter((s): s is ArrowShape => s.type === "arrow");
}

/** Page (screen) coordinates of a world point, using the live viewport. */
export async function toScreen(page: Page, world: Point): Promise<Point> {
  const canvas = await page.getByRole("main", { name: /Whiteboard canvas/ }).boundingBox();
  const vp = await page.evaluate(() => window.__whiteboard?.viewport() ?? { x: 0, y: 0, scale: 1 });
  if (!canvas) throw new Error("canvas not visible");
  return { x: canvas.x + world.x * vp.scale + vp.x, y: canvas.y + world.y * vp.scale + vp.y };
}

export function center(shape: Shape): Point {
  return { x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 };
}

export async function drag(page: Page, from: Point, to: Point): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}

/**
 * The modifier the app listens for: it picks Cmd or Ctrl from the user agent, which a
 * Playwright device profile may set to a different OS than the machine running the test.
 */
export async function modKey(page: Page): Promise<"Meta" | "Control"> {
  const mac = await page.evaluate(() => /mac|iphone|ipad/i.test(navigator.userAgent));
  return mac ? "Meta" : "Control";
}
