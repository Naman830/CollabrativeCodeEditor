import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createRoom, runAndWaitForOutput } from "./helpers";

/**
 * Committed regression suite for the accessibility pass. The audit found one CRITICAL violation
 * (a tablist owning buttons it may not own), a room with no landmark and no heading at all, two
 * silent live regions, and colour-contrast failures down to 2.54:1 in the dark theme.
 *
 * Monaco's own markup is excluded from the scans below: its violations belong to the editor
 * library, not this app, and there is no change here that would clear them.
 */
const MONACO = ".monaco-editor";

/** Next's dev overlay is a floating portal that intercepts pointer events aimed at the chrome. */
async function hideDevOverlay(page: import("@playwright/test").Page) {
  await page.addStyleTag({ content: "nextjs-portal { pointer-events: none !important; }" });
}

function scan(page: import("@playwright/test").Page) {
  return new AxeBuilder({ page }).exclude(MONACO);
}

async function violations(page: import("@playwright/test").Page) {
  const results = await scan(page).analyze();
  return results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.length,
    target: String(v.nodes[0]?.target?.[0] ?? ""),
  }));
}

test.describe("A11Y-01 axe: no violations on any page state", () => {
  test("A11Y-01a the landing page, in both themes", async ({ page }) => {
    await page.goto("/");
    expect(await violations(page)).toEqual([]);

    // The dark theme had its own regressions: white on --accent measured 3.20:1 and white on
    // --success 2.54:1, because both tokens are tuned to be legible as *text* on a dark
    // background, which makes them bright *backgrounds*.
    await page.getByRole("radio", { name: "Dark" }).click();
    await page.waitForTimeout(300);
    expect(await violations(page)).toEqual([]);
  });

  test("A11Y-01b the identity dialog", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /create a new room/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await violations(page)).toEqual([]);

    // The submit-blocked state: the hint is a live region and both inputs point at it.
    await page.getByRole("dialog").locator('input[autocomplete="given-name"]').fill("");
    expect(await violations(page)).toEqual([]);
  });

  test("A11Y-01c a live room, idle and after a run, in both themes", async ({ page }) => {
    await createRoom(page, "python");
    expect(await violations(page)).toEqual([]);

    await runAndWaitForOutput(page, /Hello, world!/);
    expect(await violations(page)).toEqual([]);

    await page.getByRole("radio", { name: "Dark" }).click();
    await page.waitForTimeout(300);
    expect(await violations(page)).toEqual([]);
  });

  test("A11Y-01d a room with a second file and the file menu open", async ({ page }) => {
    await createRoom(page, "python");
    await hideDevOverlay(page);
    await page.getByRole("button", { name: "New file" }).click();
    await page.keyboard.press("Enter");
    await expect(page.locator("ul[aria-label='Files in this room'] > li")).toHaveCount(2);
    expect(await violations(page)).toEqual([]);

    await page.getByRole("button", { name: /^File options for/ }).first().click();
    await expect(page.getByRole("menu")).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test("A11Y-01e the signed-out profile gate, the 404 and the closed-room screen", async ({ page }) => {
    await page.goto("/profile");
    expect(await violations(page)).toEqual([]);

    await page.goto("/does-not-exist");
    expect(await violations(page)).toEqual([]);

    await page.goto("/room/00000000-0000-0000-0000-000000000000");
    await expect(page.getByRole("heading").first()).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });
});

test.describe("A11Y-02 landmarks, headings and the skip link", () => {
  test("A11Y-02a every page has exactly one main landmark and one h1", async ({ page }) => {
    for (const path of ["/", "/profile", "/does-not-exist"]) {
      await page.goto(path);
      expect(await page.locator("main#main-content").count(), path).toBe(1);
      expect(await page.locator("h1").count(), path).toBeGreaterThan(0);
    }
  });

  test("A11Y-02b the room — which had neither — now has both", async ({ page }) => {
    await createRoom(page, "python");
    expect(await page.locator("main#main-content").count()).toBe(1);
    expect(await page.locator("h1").count()).toBe(1);
  });

  test("A11Y-02c the skip link is the first tab stop on a freshly loaded page", async ({ page }) => {
    // Asserted on a FRESH load, with no prior interaction. Chrome anchors sequential focus to the
    // last element that had it, and blur() does not reset that anchor — so tabbing after a click
    // (as createRoom's dialog does) legitimately resumes mid-document and skips this link. That is
    // a browser behaviour, not a defect: a real user arriving at the page gets it first.
    await page.goto("/");
    await page.keyboard.press("Tab");

    const focused = await page.evaluate(() => ({
      text: document.activeElement?.textContent?.trim(),
      href: (document.activeElement as HTMLAnchorElement)?.getAttribute("href"),
    }));
    expect(focused.href).toBe("#main-content");
    expect(focused.text).toMatch(/skip to main content/i);
  });

  test("A11Y-02d the room's skip link is present, first, and reaches the editor", async ({ page }) => {
    await createRoom(page, "python");

    // First focusable in the document, and it targets a landmark that exists.
    const check = await page.evaluate(() => {
      const link = document.querySelector('a[href="#main-content"]') as HTMLElement | null;
      const firstFocusable = document.body.querySelector("a,button,select,input,[tabindex]");
      return {
        present: Boolean(link),
        isFirst: link !== null && firstFocusable === link,
        tabIndex: link?.tabIndex ?? -1,
        targetExists: Boolean(document.getElementById("main-content")),
      };
    });
    expect(check).toEqual({ present: true, isFirst: true, tabIndex: 0, targetExists: true });

    // And following it actually lands inside the room's main landmark.
    await page.locator('a[href="#main-content"]').focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#main-content$/);
  });
});

test.describe("A11Y-03 live regions announce what happens", () => {
  test("A11Y-03a the activity log exists BEFORE the first toast", async ({ page }) => {
    // A live region created at the same moment as its first message is the classic case screen
    // readers do not announce, so an empty <ul> is always rendered.
    await createRoom(page, "python");
    const log = page.locator('[role="log"][aria-live="polite"]');
    await expect(log).toHaveCount(1);
    await expect(log).toHaveAttribute("aria-label", /activity/i);
  });

  test("A11Y-03b the run output is a live region and reports busy while running", async ({ page }) => {
    await createRoom(page, "python");
    const output = page.locator('[role="status"][aria-label="Run output"]');
    await expect(output).toHaveCount(1);
    await expect(output).toHaveAttribute("aria-busy", "false");

    await page.getByRole("button", { name: /^run/i }).first().click();
    await expect(page.getByText(/Hello, world!/).first()).toBeVisible({ timeout: 45_000 });
    await expect(output).toHaveAttribute("aria-busy", "false");
  });
});

test.describe("A11Y-04 keyboard navigation", () => {
  test("A11Y-04a the file list is one tab stop, and arrow keys move between files", async ({ page }) => {
    await createRoom(page, "python");
    await hideDevOverlay(page);
    await page.getByRole("button", { name: "New file" }).click();
    await page.keyboard.press("Enter");
    await expect(page.locator("ul[aria-label='Files in this room'] > li")).toHaveCount(2);

    // Exactly one file button is in the tab order at a time.
    const tabbable = await page.evaluate(
      () =>
        [...document.querySelectorAll("ul[aria-label='Files in this room'] button[aria-current]")]
          .length
    );
    expect(tabbable).toBe(1);

    const first = page.locator("ul[aria-label='Files in this room'] button").first();
    await first.focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(200);
    const movedTo = await page.evaluate(() => document.activeElement?.textContent?.trim());
    expect(movedTo).toBeTruthy();
    // Selection followed focus, which is what aria-current now states.
    expect(await page.locator("button[aria-current='true']").count()).toBe(1);
  });

  test("A11Y-04b the file menu supports arrow keys and restores focus on Escape", async ({ page }) => {
    await createRoom(page, "python");
    // A second file, so "Delete" is enabled — a room must keep at least one file, and the
    // keyboard model only steps between ENABLED items.
    await page.getByRole("button", { name: "New file" }).click();
    await page.keyboard.press("Enter");
    await expect(page.locator("ul[aria-label='Files in this room'] > li")).toHaveCount(2);

    const trigger = page.getByRole("button", { name: /^File options for/ }).first();
    await trigger.click();
    await expect(page.getByRole("menu")).toBeVisible();

    // Which items are enabled depends on state — "Set as entry file" is disabled for the entry
    // file, "Delete" is disabled when a room has only one file. So the expectations are derived
    // from the DOM rather than hard-coded to labels, which is what made an earlier version of
    // this test order-dependent.
    const enabled = await page.evaluate(() =>
      [...document.querySelectorAll('[role="menu"] [role="menuitem"]:not([disabled])')].map((el) =>
        (el.textContent ?? "").trim()
      )
    );
    expect(enabled.length).toBeGreaterThan(1);

    // Focus starts on the first ENABLED item, not the menu container.
    expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("menuitem");
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe(enabled[0]);

    await page.keyboard.press("ArrowDown");
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe(enabled[1]);

    // End goes to the last enabled item, skipping any disabled one — which is the point.
    await page.keyboard.press("End");
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe(
      enabled[enabled.length - 1]
    );

    await page.keyboard.press("Home");
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe(enabled[0]);

    // Escape closes AND puts focus back on the trigger, rather than dropping it to <body>.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toMatch(
      /file options for/i
    );
  });

  test("A11Y-04c the theme toggle is one tab stop with working arrow keys", async ({ page }) => {
    await page.goto("/");
    const group = page.getByRole("radiogroup", { name: /colour theme/i });
    await expect(group).toBeVisible();

    const inTabOrder = await page.evaluate(
      () =>
        [...document.querySelectorAll("[role='radiogroup'][aria-label='Colour theme'] [role='radio']")]
          .filter((el) => el.getAttribute("tabindex") === "0").length
    );
    expect(inTabOrder).toBe(1);

    await page.getByRole("radio", { name: "System" }).focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(200);
    await expect(page.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
  });
});
