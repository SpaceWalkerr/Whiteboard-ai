import { expect, test } from "./fixtures";
import { deleteE2EUsers } from "./auth";
import { ensureSignedIn } from "./helpers";

// Phase 10. The board limit is the real server's; the checkout part mocks Razorpay and the
// billing endpoints in the browser (a real test-mode payment is a manual check — see
// PROGRESS.md), so it runs without payment keys.

test.afterAll(async () => {
  await deleteE2EUsers();
});

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, x-share-token",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

test("a Free user's 4th board gets the upgrade prompt, which leads to the plans", async ({
  page,
}) => {
  await ensureSignedIn(page, "Limit tester");
  for (let i = 0; i < 3; i++) {
    await page.goto("/app");
    await page.getByRole("button", { name: "New board" }).click();
    await page.waitForURL("**/board/*");
  }
  await page.goto("/app");
  await page.getByRole("button", { name: "New board" }).click();
  const dialog = page.getByRole("dialog", { name: "Upgrade for unlimited boards" });
  await expect(dialog).toContainText("includes 3 boards");
  await expect(dialog.getByRole("table", { name: "Plan comparison" })).toBeVisible();
  await dialog.getByRole("link", { name: "See plans and upgrade" }).click();
  await page.waitForURL("**/pricing");
  await expect(page.getByRole("region", { name: "Pro", exact: true })).toContainText("₹399");
});

test("checkout: Razorpay's success hands over to the server, then billing shows Pro", async ({
  page,
}) => {
  await ensureSignedIn(page, "Buyer");
  const subscriptionId = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const pro = {
    id: subscriptionId,
    orgId: null,
    orgName: null,
    planId: "pro_monthly",
    tier: "pro",
    status: "active",
    seats: 1,
    currentPeriodEnd: "2026-10-27T00:00:00.000Z",
    nextChargeAt: "2026-10-27T00:00:00.000Z",
    nextChargeMinor: 39900,
    currency: "INR",
    cancelAtPeriodEnd: false,
    graceUntil: null,
    canManage: true,
    scheduledChange: false,
  };
  let paid = false;
  const summary = () => ({
    plan: paid ? "pro" : "free",
    source: paid ? "subscription" : "free",
    validUntil: null,
    subscriptions: paid ? [pro] : [],
    invoices: [],
    usage: {
      boards: 0,
      boardLimit: paid ? null : 3,
      lockedBoards: 0,
      aiReviewsUsed: 0,
      aiReviewsLimit: paid ? 100 : 5,
      editorsPerBoard: paid ? 10 : 3,
    },
    studentTrial: { eligible: false, activeUntil: null },
    teams: [],
    checkoutAvailable: true,
  });
  const checkoutBodies: unknown[] = [];
  await page.route("**/billing/plans", (route) =>
    route.fulfill({
      headers: CORS,
      json: {
        checkoutAvailable: true,
        plans: [
          {
            id: "pro_monthly",
            tier: "pro",
            interval: "month",
            currency: "INR",
            amountMinor: 39900,
            perSeat: false,
          },
          {
            id: "pro_yearly",
            tier: "pro",
            interval: "year",
            currency: "INR",
            amountMinor: 399000,
            perSeat: false,
          },
          {
            id: "team_monthly",
            tier: "team",
            interval: "month",
            currency: "INR",
            amountMinor: 99900,
            perSeat: true,
          },
          {
            id: "team_yearly",
            tier: "team",
            interval: "year",
            currency: "INR",
            amountMinor: 999000,
            perSeat: true,
          },
        ],
      },
    }),
  );
  await page.route("**/billing/checkout", (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ headers: CORS });
    checkoutBodies.push(route.request().postDataJSON());
    return route.fulfill({
      headers: CORS,
      json: {
        provider: "razorpay",
        subscriptionId,
        razorpay: { keyId: "rzp_test_mock", subscriptionId: "sub_mock123" },
        prefill: { email: null, name: null },
        description: "Whiteboard.ai Pro (monthly)",
      },
    });
  });
  await page.route("**/billing/refresh", (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ headers: CORS });
    paid = true;
    return route.fulfill({ headers: CORS, json: summary() });
  });
  await page.route(/\/billing$/, (route) => route.fulfill({ headers: CORS, json: summary() }));
  // Razorpay's checkout script, replaced by a stub that "pays" at once.
  await page.route("https://checkout.razorpay.com/**", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `window.Razorpay = function (options) {
        window.__razorpayOptions = options;
        this.open = function () { setTimeout(function () { options.handler({}); }, 50); };
        this.on = function () {};
      };`,
    }),
  );

  await page.goto("/pricing");
  await page
    .getByRole("region", { name: "Pro", exact: true })
    .getByRole("button", { name: "Get Pro" })
    .click();
  await page.waitForURL("**/app/settings/billing?welcome=1");
  await expect(page.getByRole("status").first()).toContainText("Your Pro plan is active");
  await expect(page.getByRole("heading", { name: "Your plan: Pro" })).toBeVisible();
  expect(checkoutBodies).toEqual([{ planId: "pro_monthly" }]);
  const options = await page.evaluate(
    () =>
      (window as unknown as { __razorpayOptions: { subscription_id: string; key: string } })
        .__razorpayOptions,
  );
  expect(options).toMatchObject({ subscription_id: "sub_mock123", key: "rzp_test_mock" });
});
