import { expect, test, type Page } from "@playwright/test";
import { deleteE2EUsers, setPlan } from "./auth";
import { ensureSignedIn, insertShape, shapes } from "./helpers";

// Phase 9: two browsers collaborate on a private (end-to-end encrypted) board. The key lives
// only in the link's fragment; no request, WebSocket frame or API response carries a label
// in plaintext; opening the board without the key shows the key prompt.

test.afterAll(async () => {
  await deleteE2EUsers();
});

/** Records everything a page sends and receives over the network (frames + HTTP bodies). */
function recordTraffic(page: Page): { text: () => string; urls: string[] } {
  const chunks: string[] = [];
  const urls: string[] = [];
  const add = (payload: string | Buffer) => {
    chunks.push(typeof payload === "string" ? payload : payload.toString("latin1"));
    if (typeof payload !== "string") chunks.push(payload.toString("utf8"));
  };
  page.on("websocket", (ws) => {
    urls.push(ws.url());
    ws.on("framereceived", (frame) => {
      add(frame.payload);
    });
    ws.on("framesent", (frame) => {
      add(frame.payload);
    });
  });
  page.on("request", (request) => {
    urls.push(request.url());
    const body = request.postData();
    if (body) chunks.push(body);
  });
  page.on("response", (response) => {
    void response
      .text()
      .then((body) => chunks.push(body))
      .catch(() => undefined);
  });
  return { text: () => chunks.join("\n"), urls };
}

async function labelSelected(page: Page, label: string): Promise<void> {
  const field = page.getByLabel("Label", { exact: true });
  await field.fill(label);
  await field.press("Enter");
}

async function waitSaved(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__whiteboard?.saveState() === "saved");
}

test("two people collaborate on a private board; the network never sees its content", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const owner = await (await browser.newContext()).newPage();
  const friend = await (await browser.newContext()).newPage();
  const ownerTraffic = recordTraffic(owner);
  const friendTraffic = recordTraffic(friend);
  const serviceLabel = `Payments service ${crypto.randomUUID().slice(0, 8)}`;
  const dbLabel = `Ledger database ${crypto.randomUUID().slice(0, 8)}`;

  // The owner (Pro) creates a private board and must confirm they saved its link.
  const ownerUser = await ensureSignedIn(owner, "Owner");
  await setPlan(ownerUser, "pro");
  await owner.goto("/app");
  await owner.getByRole("button", { name: "New private board" }).click();
  await owner.waitForURL(/\/board\/[^#]+#key=[A-Za-z0-9_-]{43}$/);
  const saveDialog = owner.getByRole("dialog", { name: "Save this board's link" });
  await expect(saveDialog).toBeVisible();
  const link = await saveDialog.getByRole("textbox", { name: "Link with key" }).inputValue();
  expect(link).toBe(owner.url());
  await saveDialog.getByLabel("I've saved the link somewhere safe").check();
  await saveDialog.getByRole("button", { name: "Start drawing" }).click();
  await expect(owner.getByRole("button", { name: "End-to-end encrypted" })).toBeVisible();
  await owner.waitForFunction(() => window.__whiteboard?.status() === "connected");

  // Share with an editor link; the copied link carries the key in its fragment.
  await owner.getByRole("button", { name: "Share" }).click();
  const share = owner.getByRole("dialog", { name: "Share board" });
  await expect(share.getByRole("note")).toContainText("We can't recover it");
  await expect(
    share.getByRole("checkbox", { name: /Anyone with the board's link can view/ }),
  ).toBeDisabled();
  await share.getByRole("combobox", { name: "Access for the new link" }).click();
  await owner.getByRole("option", { name: "Can edit" }).click();
  await share.getByRole("button", { name: "Create link" }).click();
  const shareUrl = await share.getByRole("textbox", { name: "New share link" }).inputValue();
  expect(shareUrl).toMatch(/\/s\/[^#]+#key=[A-Za-z0-9_-]{43}$/);
  await owner.keyboard.press("Escape");

  // The friend joins through the link (the key survives the /s/ redirect).
  await ensureSignedIn(friend, "Friend");
  await friend.goto(shareUrl);
  await friend.waitForURL(/\/board\/[^#]+#key=/);
  await friend.waitForFunction(() => window.__whiteboard?.status() === "connected");

  // Both draw; each sees the other's labelled shapes.
  await owner.locator("[data-board-canvas]").click({ position: { x: 600, y: 400 } });
  await insertShape(owner, "service");
  await labelSelected(owner, serviceLabel);
  await friend.locator("[data-board-canvas]").click({ position: { x: 600, y: 400 } });
  await insertShape(friend, "database");
  await labelSelected(friend, dbLabel);
  for (const page of [owner, friend]) {
    await expect
      .poll(async () => (await shapes(page)).map((s) => ("label" in s ? s.label : "")).sort())
      .toEqual([dbLabel, serviceLabel].sort());
    await waitSaved(page);
  }

  // Nothing that crossed the network had a label in it, and the key never left the fragment.
  const key = new URL(link).hash.replace("#key=", "");
  for (const traffic of [ownerTraffic, friendTraffic]) {
    const text = traffic.text();
    expect(text).not.toContain(serviceLabel);
    expect(text).not.toContain(dbLabel);
    expect(text).not.toContain(key);
    for (const url of traffic.urls) expect(url).not.toContain(key);
  }

  // Without the key on the device (e.g. opened from an invite email), the board asks for
  // the link, and opens once it's pasted.
  await friend.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase("whiteboard:keys");
        request.onsuccess = () => {
          resolve();
        };
        request.onerror = () => {
          resolve();
        };
      }),
  );
  await friend.goto(new URL(link).pathname);
  await expect(
    friend.getByRole("heading", { name: "This board is end-to-end encrypted" }),
  ).toBeVisible();
  await friend.getByLabel("Link with key").fill(link);
  await friend.getByRole("button", { name: "Open board" }).click();
  await friend.waitForFunction(() => window.__whiteboard?.status() === "connected");
  await expect.poll(async () => (await shapes(friend)).length).toBe(2);
});
