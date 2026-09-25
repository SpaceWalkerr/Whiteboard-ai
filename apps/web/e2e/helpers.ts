import { expect, type BrowserContext, type Page } from "@playwright/test";
import { createE2EUser, signInWithMagicLink, type E2EUser } from "./auth";
import type { ArrowShape, Shape } from "@whiteboard/shared/board";

export interface Point {
  x: number;
  y: number;
}

const signedIn = new WeakMap<BrowserContext, E2EUser>();

/** Signs the page's browser context in as a fresh user (once per context). */
export async function ensureSignedIn(page: Page, name = "Tester"): Promise<E2EUser> {
  const existing = signedIn.get(page.context());
  if (existing) return existing;
  const user = await createE2EUser(name);
  await signInWithMagicLink(page, user);
  signedIn.set(page.context(), user);
  return user;
}

/**
 * Without `url`: signs in (if needed) and creates a new board from the dashboard. With `url`:
 * opens that board. Either way, waits until it is connected to the sync server.
 */
export async function openBoard(page: Page, url?: string): Promise<void> {
  if (url === undefined) {
    await ensureSignedIn(page);
    await page.goto("/app");
    await page.getByRole("button", { name: "New board" }).click();
    await page.waitForURL("**/board/*");
  } else {
    await page.goto(url);
  }
  await expect(page.getByRole("main", { name: /Whiteboard canvas/ })).toBeVisible();
  await page.waitForFunction(() => window.__whiteboard?.status() === "connected");
}

/** Owner side: creates an editor share link through the Share dialog and returns its URL. */
export async function createShareLink(
  page: Page,
  role: "editor" | "viewer" = "editor",
): Promise<string> {
  await page.getByRole("button", { name: "Share" }).click();
  const dialog = page.getByRole("dialog", { name: "Share board" });
  await dialog.getByRole("combobox", { name: "Access for the new link" }).click();
  await page.getByRole("option", { name: role === "editor" ? "Can edit" : "Can view" }).click();
  await dialog.getByRole("button", { name: "Create link" }).click();
  const url = await dialog.getByRole("textbox", { name: "New share link" }).inputValue();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  return url;
}

/** Collaborator side: signs in as a new user and opens a share link. */
export async function joinViaLink(
  page: Page,
  url: string,
  name = "Collaborator",
): Promise<E2EUser> {
  const user = await ensureSignedIn(page, name);
  await page.goto(url);
  await page.waitForURL("**/board/*");
  await expect(page.getByRole("main", { name: /Whiteboard canvas/ })).toBeVisible();
  await page.waitForFunction(() => window.__whiteboard?.status() === "connected");
  return user;
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
