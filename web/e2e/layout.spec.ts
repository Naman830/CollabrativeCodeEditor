import { expect, test } from "@playwright/test";
import { createRoom, readEditor, runAndWaitForOutput } from "./helpers";

/**
 * CLAUDE.md is explicit that the way to test the resizable layout is NOT to look at the layout:
 * it is to assert the room's shared output SURVIVES. `useCollabRoom`'s master effect is keyed on
 * the Monaco instance, so a remount destroys the Y.Doc, the provider, the awareness handler and
 * every MonacoBinding — wiping the room's output for everyone and re-firing the join toasts.
 * If the output resets to "Output will appear here…", the editor remounted.
 */
test.describe("RSP-01 the editor must never unmount", () => {
  test("RSP-01a the shared output survives collapse, expand and an orientation flip", async ({ page }) => {
    await createRoom(page, "python");
    await runAndWaitForOutput(page, /Hello, world!/);
    const before = await readEditor(page);

    const outputVisible = () => expect(page.getByText(/Hello, world!/).first()).toBeVisible();
    const collapse = () => page.getByRole("button", { name: /^collapse the output$/i });
    const expand = () => page.getByRole("button", { name: /^expand the output$/i });

    // 1. Side by side: collapsing takes the panel to width 0, so there is nothing legible to
    //    leave behind and CodeEditor LENDS a restore button to the editor's tab strip.
    await collapse().click();
    await page.waitForTimeout(500);
    await expect(page.getByText(/Hello, world!/).first()).toBeHidden();
    // The lent button is the ONLY usable restore here: the panel collapses to width 0, so its own
    // "Expand the output" is still in the DOM and reported visible but cannot receive a click.
    // That asymmetry is exactly why CodeEditor lends one at all.
    const lent = page.getByRole("button", { name: /^show output$/i });
    await expect(
      lent,
      "side by side, a collapsed output is 0px wide so the editor's tab strip must lend a restore"
    ).toBeVisible();
    await lent.click();
    await page.waitForTimeout(500);
    await outputVisible();

    // 2. Stacked: it collapses to PANEL_STRIP_HEIGHT instead, so the collapsed panel IS its own
    //    tab strip, keeps its own restore, and no button is lent.
    const stack = page.getByRole("button", { name: /stack the output below the editor/i });
    await stack.click();
    // Wait for the flip to actually take effect — the control's label describes the NEXT action,
    // so its disappearance is the proof. Assuming the click landed silently left the layout
    // horizontal, where the panel collapses to 0px and its own restore is genuinely unclickable.
    await expect(stack).toBeHidden({ timeout: 10_000 });
    await outputVisible();

    await collapse().click();
    await page.waitForTimeout(500);
    await expect(
      expand(),
      "stacked, the collapsed panel is its own strip and must carry the control that undoes it"
    ).toBeVisible();
    // And nothing is lent in this orientation, because there is a legible strip to leave behind.
    await expect(page.getByRole("button", { name: /^show output$/i })).toHaveCount(0);
    await expand().click();
    await page.waitForTimeout(500);
    await outputVisible();

    // The document is untouched, and the editor is the same live instance.
    expect(await readEditor(page)).toBe(before);
    await expect(page.locator(".monaco-editor")).toHaveCount(1);
  });

  test("RSP-01b dragging the divider does not reset the room", async ({ page }) => {
    await createRoom(page, "python");
    await runAndWaitForOutput(page, /Hello, world!/);

    const separator = page.locator('[role="separator"]').first();
    await expect(separator).toBeVisible();
    const box = await separator.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 120, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(400);
    }
    await expect(page.getByText(/Hello, world!/).first()).toBeVisible();
  });

  test("RSP-01c the separator carries its keyboard contract from the library", async ({ page }) => {
    await createRoom(page, "python");
    const separator = page.locator('[role="separator"]').first();
    // Free from react-resizable-panels' Separator: reimplementing any of this is forbidden.
    await expect(separator).toHaveAttribute("aria-valuenow", /\d/);
    await expect(separator).toHaveAttribute("tabindex", "0");

    await separator.focus();
    const before = await separator.getAttribute("aria-valuenow");
    // The default split is side by side, so the separator is vertical and responds to
    // ArrowLeft/ArrowRight. Press both axes rather than assuming an orientation.
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(400);
    expect(await separator.getAttribute("aria-valuenow")).not.toBe(before);
  });
});

test.describe("RSP-02 narrow viewports force a stack rather than hiding a pane", () => {
  test("RSP-02a a phone-width viewport keeps the editor mounted and the output reachable", async ({
    page,
  }) => {
    await createRoom(page, "python");
    await runAndWaitForOutput(page, /Hello, world!/);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);

    // A tab switcher was rejected precisely because it either unmounts the editor or hides it
    // with display:none, which reports 0x0 to automaticLayout and can bring Monaco back blank.
    await expect(page.locator(".monaco-editor")).toBeVisible();
    await expect(page.locator(".monaco-editor")).toHaveCount(1);
    const box = await page.locator(".monaco-editor").boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(0);
    expect(box?.height ?? 0).toBeGreaterThan(0);

    // The run output is still there — the layout change did not reset shared state.
    await expect(page.getByText(/Hello, world!/).first()).toBeVisible();
  });

  test("RSP-02b the page never scrolls horizontally", async ({ page }) => {
    await createRoom(page, "python");
    for (const width of [1280, 768, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(300);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(1);
    }
  });
});
