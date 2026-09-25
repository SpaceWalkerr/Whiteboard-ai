import { expect, test } from "@playwright/test";
import { createE2EUser, deleteE2EUsers, signInWithMagicLink } from "./auth";
import { createShareLink, insertShape, joinViaLink, openBoard, shapes } from "./helpers";

test.afterAll(async () => {
  await deleteE2EUsers();
});

test.describe("accounts, sharing and permissions", () => {
  test("sign up, create a board, invite a second user by email, and they edit it", async ({
    browser,
  }) => {
    const a = await (await browser.newContext()).newPage();
    const b = await (await browser.newContext()).newPage();

    // A signs up with a magic link (captured in test mode) and creates a board.
    await openBoard(a);
    const boardUrl = a.url();

    // A invites B's email as an editor from the Share dialog.
    const bob = await createE2EUser("Bob");
    await a.getByRole("button", { name: "Share" }).click();
    const dialog = a.getByRole("dialog", { name: "Share board" });
    await dialog.getByLabel("Invite by email").fill(bob.email);
    await dialog.getByRole("button", { name: "Invite" }).click();
    await expect(dialog.getByText(bob.email)).toBeVisible();
    await a.keyboard.press("Escape");

    // B signs in; the pending invite for their email is accepted automatically.
    await signInWithMagicLink(b, bob);
    const shared = b.getByRole("region", { name: "Shared with me" });
    await expect(shared.getByRole("link")).toHaveCount(1);
    await shared.getByRole("link").click();
    await b.waitForURL(boardUrl);
    await b.waitForFunction(() => window.__whiteboard?.status() === "connected");

    // B edits; A sees it.
    await insertShape(b, "service");
    await expect.poll(async () => (await shapes(a)).map((s) => s.type)).toEqual(["service"]);
  });

  test("a viewer gets a read-only board", async ({ browser }) => {
    const owner = await (await browser.newContext()).newPage();
    const viewer = await (await browser.newContext()).newPage();
    await openBoard(owner);
    await insertShape(owner, "database");
    const link = await createShareLink(owner, "viewer");
    await joinViaLink(viewer, link, "Viewer");

    await expect(viewer.getByText("View only")).toBeVisible();
    await expect(viewer.getByRole("radio", { name: "Rectangle" })).toHaveCount(0);
    await expect(viewer.getByRole("navigation", { name: "System design shapes" })).toHaveCount(0);
    // Keyboard editing does nothing either.
    await viewer.keyboard.press("/");
    await expect(viewer.getByRole("combobox", { name: "Shape name" })).toHaveCount(0);
    await viewer.keyboard.press("ControlOrMeta+a");
    await viewer.keyboard.press("Delete");
    await viewer.waitForTimeout(500);
    expect((await shapes(owner)).map((s) => s.type)).toEqual(["database"]);
  });

  test("revoking a share link ends the viewer's live session within seconds", async ({
    browser,
  }) => {
    const owner = await (await browser.newContext()).newPage();
    const viewer = await (await browser.newContext()).newPage();
    await openBoard(owner);
    const link = await createShareLink(owner, "viewer");
    await joinViaLink(viewer, link, "Viewer");

    await owner.getByRole("button", { name: "Share" }).click();
    await owner
      .getByRole("dialog", { name: "Share board" })
      .getByRole("button", { name: "Revoke" })
      .click();
    await expect(viewer.getByRole("alertdialog", { name: "Your access was removed" })).toBeVisible({
      timeout: 5_000,
    });
  });
});
