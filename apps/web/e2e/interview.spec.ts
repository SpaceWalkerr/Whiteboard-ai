import { expect, test, type Page } from "@playwright/test";
import { deleteE2EUsers, setPlan } from "./auth";
import {
  createShareLink,
  ensureSignedIn,
  insertShape,
  joinViaLink,
  openBoard,
  shapes,
} from "./helpers";

// A full mock interview in two browsers: the interviewer starts it, the candidate draws,
// the interviewer writes a private note, scores and ends it, then reads the summary and
// replays the session. Everything the candidate's browser receives (WebSocket frames and
// HTTP responses) is recorded and must not contain the note, the scorecard or hidden hints.

test.afterAll(async () => {
  await deleteE2EUsers();
});

/** Records every WebSocket frame and HTTP response body a page receives. */
function recordTraffic(page: Page): { text: () => string } {
  const chunks: string[] = [];
  page.on("websocket", (ws) => {
    ws.on("framereceived", (frame) => {
      chunks.push(
        typeof frame.payload === "string" ? frame.payload : frame.payload.toString("latin1"),
      );
      if (typeof frame.payload !== "string") chunks.push(frame.payload.toString("utf8"));
    });
  });
  page.on("response", (response) => {
    void response
      .text()
      .then((body) => chunks.push(body))
      .catch(() => undefined);
  });
  return { text: () => chunks.join("\n") };
}

test("a full mock interview: start, draw, note, score, end, summary, replay", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const interviewer = await (await browser.newContext()).newPage();
  const candidate = await (await browser.newContext()).newPage();
  const traffic = recordTraffic(candidate);
  const note = `Private note ${crypto.randomUUID()}`;
  const comment = `Scorecard comment ${crypto.randomUUID()}`;
  const hiddenHint =
    "How would you generate unique codes across many servers without a single counter bottleneck?";

  const ivy = await ensureSignedIn(interviewer, "Ivy");
  await setPlan(ivy, "team");
  await openBoard(interviewer);
  const link = await createShareLink(interviewer, "editor");
  await joinViaLink(candidate, link, "Cam");

  // Start: the candidate is on the board, so they are offered as the candidate.
  await interviewer.getByRole("button", { name: "Start interview" }).click();
  const dialog = interviewer.getByRole("dialog", { name: "Start an interview" });
  await dialog.getByText("URL shortener", { exact: true }).click();
  await expect(dialog.getByRole("combobox", { name: "Cam" })).toHaveValue("candidate");
  await dialog.getByRole("button", { name: "Start interview" }).click();

  // Both see the question and the countdown; only the interviewer has the panel.
  await expect(candidate.getByRole("heading", { name: "URL shortener" })).toBeVisible();
  await expect(candidate.getByRole("timer")).toBeVisible();
  await expect(interviewer.getByRole("complementary", { name: "Interviewer" })).toBeVisible();
  await expect(candidate.getByRole("complementary", { name: "Interviewer" })).toHaveCount(0);
  // AI tools are off for the candidate during the interview.
  await expect(candidate.getByRole("button", { name: "Check design" })).toHaveCount(0);
  await expect(candidate.getByRole("button", { name: "AI review" })).toHaveCount(0);

  // The interviewer reveals the first hint; the candidate sees it.
  const panel = interviewer.getByRole("complementary", { name: "Interviewer" });
  await panel.getByRole("button", { name: "Show to candidate" }).first().click();
  await expect(candidate.getByText("Estimate storage: how many links over 5 years")).toBeVisible();

  // The candidate draws.
  await insertShape(candidate, "service");
  await expect
    .poll(async () => (await shapes(interviewer)).map((s) => s.type))
    .toEqual(["service"]);

  // A private note and a scorecard.
  await panel.getByRole("tab", { name: "Notes" }).click();
  await panel.getByLabel("New note (private to interviewers)").fill(note);
  await panel.getByRole("button", { name: "Add note" }).click();
  await expect(panel.getByText(note)).toBeVisible();
  await panel.getByRole("tab", { name: "Scorecard" }).click();
  const scoping = panel.getByRole("group", { name: "Requirements & scoping" });
  await scoping.locator("label").filter({ hasText: "Good" }).click();
  await expect(scoping.getByRole("radio", { name: /^3/ })).toBeChecked();
  await panel.getByLabel("Comment on Requirements & scoping").fill(comment);
  await panel
    .locator("label")
    .filter({ hasText: /^Hire$/ })
    .click();
  await expect(panel.getByRole("radio", { name: "Hire", exact: true })).toBeChecked();
  await panel.getByRole("button", { name: "Submit" }).click();
  await expect(panel.getByText("Submitted")).toBeVisible();

  // End: the candidate's board becomes read-only.
  await panel.getByRole("button", { name: "End interview" }).click();
  await interviewer
    .getByRole("dialog", { name: "End the interview?" })
    .getByRole("button", { name: "End interview" })
    .click();
  await expect(candidate.getByText("Interview ended")).toBeVisible();
  await expect(candidate.getByText("View only")).toBeVisible({ timeout: 10_000 });

  // Nothing private ever reached the candidate's browser.
  await candidate.waitForTimeout(500);
  const seen = traffic.text();
  expect(seen).toContain("URL shortener"); // the recording works
  expect(seen).not.toContain(note);
  expect(seen).not.toContain(comment);
  expect(seen).not.toContain(hiddenHint);
  await expect(candidate.getByRole("link", { name: "View summary" })).toHaveCount(0);

  // Summary and replay (interviewer).
  await interviewer.getByRole("link", { name: "View summary" }).click();
  await expect(interviewer.getByRole("heading", { name: "URL shortener" })).toBeVisible();
  await expect(interviewer.getByText(note)).toBeVisible();
  await expect(interviewer.getByText(comment)).toBeVisible();
  await interviewer.getByRole("link", { name: "Replay" }).click();
  const slider = interviewer.getByRole("slider", { name: "Session time" });
  await expect(slider).toBeVisible();
  await slider.fill("0");
  await expect(
    interviewer.getByRole("img", { name: /0:00 into the session, 0 shapes/ }),
  ).toBeVisible();
  await slider.press("End");
  await expect(interviewer.getByRole("img", { name: /, 1 shapes/ })).toBeVisible();
  await expect(interviewer.getByRole("button", { name: /Jump to .*Note by Ivy/ })).toBeVisible();

  // The candidate can't open the summary even with its URL.
  await candidate.goto(interviewer.url().replace(/\/replay$/, ""));
  await expect(candidate.getByRole("heading", { name: "No access" })).toBeVisible();
});
