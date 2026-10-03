import { expect, test } from "./fixtures";

test("home page loads and reaches the API", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // From the page, under its CSP: proves the API origin is allowed by connect-src and the
  // server's CORS allowlist accepts the web origin.
  const health = await page.evaluate(async () => {
    const res = await fetch("http://localhost:4000/healthz");
    return (await res.json()) as unknown;
  });
  expect(health).toEqual({ status: "ok" });
});

test("unknown routes render the SPA not-found page", async ({ page }) => {
  await page.goto("/definitely-not-a-page");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});
