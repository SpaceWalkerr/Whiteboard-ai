import { expect, test } from "@playwright/test";

test("home page loads and reaches the API", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Whiteboard.ai" })).toBeVisible();
  // Proves VITE_API_URL is baked in and the server's CORS allowlist accepts the web origin.
  await expect(page.getByRole("status")).toHaveText(/Server: ok/);
});

test("unknown routes render the SPA not-found page", async ({ page }) => {
  await page.goto("/definitely-not-a-page");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});
