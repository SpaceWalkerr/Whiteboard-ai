import { expect, test, type Page } from "@playwright/test";
import { openBoard } from "./helpers";

interface FrameStats {
  fps: number;
  p95FrameMs: number;
  frames: number;
}

/** Pans with real wheel events for `durationMs` and measures frames drawn in the page. */
async function measurePan(page: Page, durationMs: number): Promise<FrameStats> {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __measuring: boolean };
    w.__frames = [];
    w.__measuring = true;
    let last = performance.now();
    const tick = (now: number) => {
      w.__frames.push(now - last);
      last = now;
      if (w.__measuring) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const before = await page.evaluate(() => window.__whiteboard?.viewport());
  const started = Date.now();
  let direction = 1;
  let step = 0;
  while (Date.now() - started < durationMs) {
    await page.mouse.wheel(18 * direction, 10 * direction);
    if (++step % 150 === 0) direction *= -1;
  }

  // Sanity check: the wheel events really panned the board while we measured.
  const moved = await page.evaluate((start) => {
    const now = window.__whiteboard?.viewport();
    return start !== undefined && now !== undefined && (now.x !== start.x || now.y !== start.y);
  }, before);
  expect(moved).toBe(true);

  const frames = await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __measuring: boolean };
    w.__measuring = false;
    return w.__frames.slice(1);
  });
  const sorted = [...frames].sort((a, b) => a - b);
  const total = frames.reduce((sum, f) => sum + f, 0);
  return {
    fps: Math.round((frames.length / total) * 1000),
    p95FrameMs: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
    frames: frames.length,
  };
}

test("a 2,000-shape board pans smoothly", async ({ page }) => {
  await openBoard(page);
  const count = await page.evaluate(() => window.__whiteboard?.seed(2000) ?? 0);
  expect(count).toBe(2000);

  const canvas = await page.getByRole("main", { name: /Whiteboard canvas/ }).boundingBox();
  if (!canvas) throw new Error("canvas not visible");
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);

  await page.evaluate(() => {
    window.__whiteboard?.setViewport({ x: 0, y: 0, scale: 1 });
  });
  const normal = await measurePan(page, 5000);

  // Zoomed out far enough that every shape is on screen at once (low-detail rendering).
  await page.evaluate(() => {
    window.__whiteboard?.setViewport({ x: 20, y: 20, scale: 0.12 });
  });
  const overview = await measurePan(page, 5000);

  const report =
    `100% zoom: ${normal.fps} fps (p95 frame ${normal.p95FrameMs} ms, ${normal.frames} frames) | ` +
    `all 2,000 visible: ${overview.fps} fps (p95 frame ${overview.p95FrameMs} ms)`;
  test.info().annotations.push({ type: "perf", description: report });
  process.stdout.write(`[perf] ${report}\n`);

  // Guard against pathological regressions; the target is ~60 fps (see the report).
  expect(normal.fps).toBeGreaterThanOrEqual(30);
  expect(overview.fps).toBeGreaterThanOrEqual(30);
});
