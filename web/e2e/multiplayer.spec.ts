import { expect, test } from "@playwright/test";
import {
  clearEditor,
  createRoom,
  joinAsSecondTab,
  normalise,
  readEditor,
  replaceEditorContent,
} from "./helpers";

/**
 * Two tabs in ONE browser context is the correct local multiplayer test, and it is the case that
 * catches regressions: identity lives in sessionStorage (per-tab) while only the name is mirrored
 * to localStorage, and y-websocket's BroadcastChannel is disabled — so same-origin tabs sync
 * only through the server, exactly like two different people.
 */
test.describe("UF-02 guest + guest in one context", () => {
  test("UF-02a both peers appear, with distinct colours", async ({ page, context }) => {
    const roomId = await createRoom(page, "python");
    const second = await joinAsSecondTab(context, roomId);

    // Presence is announced to both sides.
    await expect(page.getByRole("list", { name: /2 people in this room/i })).toBeVisible({ timeout: 20_000 });
    await expect(second.getByRole("list", { name: /2 people in this room/i })).toBeVisible({ timeout: 20_000 });

    const colours = await page.evaluate(() =>
      [...document.querySelectorAll("[style*='background-color']")]
        .map((el) => (el as HTMLElement).style.backgroundColor)
        .filter(Boolean)
    );
    // Two peers must never render the same colour; readPeers resolves collisions by clientID.
    expect(new Set(colours).size).toBeGreaterThan(1);
    await second.close();
  });

  test("UF-02b an edit in one tab reaches the other", async ({ page, context }) => {
    const roomId = await createRoom(page, "python");
    const second = await joinAsSecondTab(context, roomId);

    await replaceEditorContent(page, "# edited by tab one");

    await expect
      .poll(async () => normalise(await readEditor(second)), { timeout: 20_000 })
      .toContain("# edited by tab one");
    await second.close();
  });

  test("UF-02c concurrent edits converge to the same text on both sides", async ({ page, context }) => {
    const roomId = await createRoom(page, "python");
    const second = await joinAsSecondTab(context, roomId);

    await clearEditor(page);
    await expect.poll(async () => (await readEditor(second)).trim().length, { timeout: 20_000 }).toBe(0);

    // Both type at once, into the same document.
    await page.locator(".monaco-editor .view-lines").first().click();
    await second.locator(".monaco-editor .view-lines").first().click();
    await Promise.all([page.keyboard.type("AAAA"), second.keyboard.type("BBBB")]);

    await expect
      .poll(
        async () => {
          const [left, right] = [normalise(await readEditor(page)), normalise(await readEditor(second))];
          return left === right && left.length > 0 ? left : null;
        },
        { timeout: 25_000 }
      )
      .not.toBeNull();

    // Both peers' characters are all present. NOT asserted: that "AAAA" and "BBBB" stay
    // contiguous — two peers inserting at the same position interleave per character, and
    // "BABBBAAA" is a perfectly correct CRDT outcome. Convergence is the invariant; ordering
    // between concurrent inserts is not.
    const converged = normalise(await readEditor(page));
    expect(converged.split("A").length - 1, `A count in ${converged}`).toBe(4);
    expect(converged.split("B").length - 1, `B count in ${converged}`).toBe(4);
    await second.close();
  });

  test("UF-02d a departure ages out promptly — the disableBc regression", async ({ page, context }) => {
    const roomId = await createRoom(page, "python");
    const second = await joinAsSecondTab(context, roomId);
    await expect(page.getByRole("list", { name: /2 people in this room/i })).toBeVisible({ timeout: 20_000 });

    await second.close();
    // With BroadcastChannel on, a sibling tab re-announced the departed client with a higher
    // clock and it never aged out. This must drop back within a couple of seconds.
    await expect(page.getByRole("list", { name: /1 person in this room/i })).toBeVisible({ timeout: 15_000 });
  });

  test("UF-02e a run by one peer is visible to the other, attributed", async ({ page, context }) => {
    const roomId = await createRoom(page, "python");
    const second = await joinAsSecondTab(context, roomId);

    await page.getByRole("button", { name: /^run/i }).first().click();
    // The result travels through the shared execution map, not a new server message.
    await expect(second.getByText(/Hello, world!/).first()).toBeVisible({ timeout: 45_000 });
    // The caption names the run's own author and file, sourced from the record.
    await expect(second.getByText(/Ada L\./).first()).toBeVisible();
    await expect(second.getByText(/main\.py/).first()).toBeVisible();
    await second.close();
  });
});

test.describe("UF-07 reload inside the grace window", () => {
  test("UF-07a the document survives a refresh by the sole peer", async ({ page }) => {
    const roomId = await createRoom(page, "python");
    await replaceEditorContent(page, "# must survive a reload");
    await page.waitForTimeout(600);

    // beforeunload fires for the sole peer. accept(), never dismiss(): dismissing CANCELS the
    // close, so the tab stays open and connected and every later assertion is wrong.
    page.on("dialog", (dialog) => dialog.accept());
    await page.reload();

    await expect(page.locator(".monaco-editor")).toBeVisible();
    await expect
      .poll(async () => normalise(await readEditor(page)), { timeout: 20_000 })
      .toContain("# must survive a reload");
    // Same room, not a new one.
    expect(page.url()).toContain(roomId);
  });
});
