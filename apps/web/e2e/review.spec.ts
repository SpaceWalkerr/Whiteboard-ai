import { expect, test, type Page, type Route } from "@playwright/test";
import { deleteE2EUsers } from "./auth";
import { arrows, center, drag, openBoard, shapes, toScreen } from "./helpers";

// The AI review UI end to end, with the review endpoints mocked in the browser: no Claude call
// is made (the server side is covered by apps/server tests and the eval).

test.afterAll(async () => {
  await deleteE2EUsers();
});

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, x-share-token",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

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
  if (!arrow) throw new Error("arrow was not created");
  return arrow.id;
}

function boardIdOf(page: Page): string {
  const id = /\/board\/([0-9a-f-]{36})/.exec(page.url())?.[1];
  if (!id) throw new Error("not on a board");
  return id;
}

async function mockQuota(page: Page, used = 0) {
  await page.route("**/me/ai-quota", (route) =>
    route.fulfill({
      headers: CORS,
      json: {
        plan: "free",
        reviewsUsed: used,
        reviewsLimit: 5,
        resetsAt: "2026-10-01T00:00:00.000Z",
        liveHints: false,
        available: true,
      },
    }),
  );
}

function preflight(route: Route): boolean {
  if (route.request().method() !== "OPTIONS") return false;
  void route.fulfill({ status: 204, headers: CORS });
  return true;
}

test.describe("AI review", () => {
  test("a review streams in, lists numbered findings and pins them on the right shapes", async ({
    page,
  }) => {
    // Before the board opens: the board page reads the quota (for live hints) on load.
    await mockQuota(page);
    await openBoard(page);
    const service = await place(page, "Service", 400, 300);
    const db = await place(page, "Database", 800, 300);
    const link = await connect(page, service, db);
    await page.keyboard.press("Escape"); // deselect: the properties panel would cover pins
    const boardId = boardIdOf(page);

    const reviewId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const createdAt = new Date().toISOString();
    const record = {
      id: reviewId,
      boardId,
      status: "completed",
      requestedBy: null,
      problemStatement: "Order service, 1k orders/s",
      requirements: "",
      model: "claude-sonnet-5",
      createdAt,
      completedAt: createdAt,
      errorCode: null,
      graph: { nodes: [], edges: [], ignored: [] },
      ruleFindings: [],
      review: {
        summary: "Solid start; the database is the weak point.",
        scores: { scalability: 5, reliability: 3, data_design: 6, security: 7, cost: 7 },
        findings: [
          {
            id: "f1",
            severity: "critical",
            dimension: "reliability",
            title: "Single database",
            explanation: "Every order depends on one database.",
            shapeIds: [db, link],
            suggestion: "Add a replica with failover.",
            ruleId: "db-spof",
          },
          {
            id: "f2",
            severity: "warning",
            dimension: "scalability",
            title: "One service instance",
            explanation: "No horizontal scaling.",
            shapeIds: [service],
            suggestion: "Run several behind a load balancer.",
            ruleId: null,
          },
        ],
        followUpQuestions: ["How do you fail over?"],
      },
    };
    let reviewed = false;
    let sentBody: unknown = null;
    await page.route(`**/boards/${boardId}/reviews`, async (route) => {
      if (preflight(route)) return;
      if (route.request().method() === "GET") {
        const summary = {
          id: reviewId,
          status: "completed",
          createdAt,
          requestedByName: "E2E",
          problemStatement: record.problemStatement,
          findingCount: 2,
          overallScore: 5.6,
        };
        await route.fulfill({ headers: CORS, json: { reviews: reviewed ? [summary] : [] } });
        return;
      }
      sentBody = route.request().postDataJSON();
      reviewed = true;
      const events = [
        { type: "stage", stage: "preparing" },
        { type: "stage", stage: "reviewing" },
        { type: "progress", outputTokens: 300 },
        { type: "stage", stage: "validating" },
        { type: "done", review: record },
      ];
      await route.fulfill({
        headers: { ...CORS, "content-type": "text/event-stream" },
        body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
      });
    });

    await page.getByRole("button", { name: "AI review" }).click();
    const panel = page.getByRole("complementary", { name: "AI review" });
    await expect(panel.getByText("No AI reviews of this board yet.")).toBeVisible();
    await panel.getByRole("button", { name: "Review this design" }).click();

    const dialog = page.getByRole("dialog", { name: "AI design review" });
    await expect(dialog.getByText("5 of 5 reviews left this month (Free plan).")).toBeVisible();
    await dialog.getByLabel(/What are you designing/).fill("Order service, 1k orders/s");
    await dialog.getByRole("button", { name: "Start review" }).click();

    await expect(panel.getByText("Solid start; the database is the weak point.")).toBeVisible();
    expect(sentBody).toEqual({ problemStatement: "Order service, 1k orders/s", requirements: "" });
    await expect(panel.getByRole("meter", { name: "Reliability score" })).toHaveAttribute(
      "value",
      "3",
    );

    // One numbered pin per finding, on its shapes; clicking one highlights them.
    await expect(page.locator("[data-review-pin]")).toHaveCount(2);
    await page.getByRole("button", { name: /Finding 1 \(Critical\): Single database/ }).click();
    expect(await page.evaluate(() => window.__whiteboard?.designCheckFocus())).toEqual([db, link]);
    await expect(panel.getByRole("button", { name: /Single database/ }).first()).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Escape closes the panel and removes the pins.
    await panel.getByRole("heading", { name: "AI review" }).focus();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(page.locator("[data-review-pin]")).toHaveCount(0);
  });

  test("when the monthly quota is used up the server's 402 shows the upgrade prompt", async ({
    page,
  }) => {
    await mockQuota(page, 4); // the UI still thinks one is left; the server decides
    await openBoard(page);
    await place(page, "Service", 400, 300);
    const boardId = boardIdOf(page);
    await page.route(`**/boards/${boardId}/reviews`, async (route) => {
      if (preflight(route)) return;
      if (route.request().method() === "GET") {
        await route.fulfill({ headers: CORS, json: { reviews: [] } });
        return;
      }
      await route.fulfill({
        status: 402,
        headers: CORS,
        json: {
          error: {
            code: "QUOTA_EXCEEDED",
            message: "You've used all 5 AI reviews included in the Free plan this month.",
          },
        },
      });
    });

    await page.keyboard.press("Shift+R");
    const panel = page.getByRole("complementary", { name: "AI review" });
    await panel.getByRole("button", { name: "Review this design" }).click();
    await page
      .getByRole("dialog", { name: "AI design review" })
      .getByRole("button", { name: "Start review" })
      .click();

    const upgrade = page.getByRole("dialog", { name: "Upgrade for more AI reviews" });
    await expect(upgrade).toContainText("You've used all 5 AI reviews");
    await expect(upgrade.getByRole("table", { name: "Plan comparison" })).toBeVisible();
    await upgrade.getByRole("button", { name: "Not now" }).click();
    await expect(upgrade).toBeHidden();
  });
});
