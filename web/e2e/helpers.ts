import type { Page, BrowserContext } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * Every selector trap this app has, in one place.
 * - The identity dialog's inputs carry no id or name, so they are matched on autocomplete.
 * - The landing page's language control is #room-language; there is no language select in the
 *   room at all since §10.1.
 * - Monaco renders spaces as non-breaking spaces, so text assertions must normalise.
 * - Room text must be read from the Monaco model, never document.body.innerText: Monaco keeps a
 *   hidden accessibility mirror, so innerText shows the content twice.
 */
export const NBSP = String.fromCharCode(160);

export function normalise(text: string): string {
  return text.replace(new RegExp(NBSP, "g"), " ").replace(/\s+/g, " ").trim();
}

export async function enterIdentity(page: Page, first: string, last: string) {
  // INVARIANT: scope to the dialog and take its submit button — never match on label text.
  // IdentityDialog's label is a `submitLabel` prop, and the landing page has its own "Join"
  // button *behind* the modal scrim: a text match picks that one, the scrim intercepts the
  // click, and the test retries until it times out with no useful error.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator('input[autocomplete="given-name"]').fill(first);
  await dialog.locator('input[autocomplete="family-name"]').fill(last);
  await dialog.locator('button[type="submit"]').click();
  await expect(dialog).toBeHidden();
}

/**
 * INVARIANT: a visible Monaco is NOT a ready room. The starter file is created only after the
 * provider fires `sync`, so between "editor visible" and "seeded" there is a window in which
 * `files` is empty, `entryFile` is null, and useCodeRunner returns early *without writing
 * anything* — a Run click in that window is silently swallowed and the output pane still reads
 * "Output will appear here…". Every helper that acts on a room must wait for this.
 */
export async function waitForRoomReady(page: Page, { seeded = true } = {}) {
  await expect(page.locator(".monaco-editor")).toBeVisible();
  // The entry file's tab is the observable proof that the file map arrived.
  await expect(page.locator('[role="tab"]').first()).toBeVisible();
  if (!seeded) return;
  // The direct signal, rather than a proxy: the document actually has text. (Save's disabled
  // state looked like a good proxy and is not — it tracks the local Monaco mirror, which lags.)
  await expect
    .poll(async () => (await readEditor(page)).trim().length, { timeout: 30_000 })
    .toBeGreaterThan(0);
}

/** Landing page -> a fresh room, as a guest. Returns the room id. */
export async function createRoom(page: Page, language = "python"): Promise<string> {
  await page.goto("/");
  await page.selectOption("#room-language", language);
  await page.getByRole("button", { name: /create a new room/i }).click();
  await enterIdentity(page, "Ada", "Lovelace");
  await page.waitForURL(/\/room\/[0-9a-f-]{36}/);
  await waitForRoomReady(page);
  return page.url().split("/room/")[1];
}

/** A second tab in the SAME context: shares localStorage, gets its own sessionStorage. */
export async function joinAsSecondTab(
  context: BrowserContext,
  roomId: string,
  first = "Grace",
  last = "Hopper"
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/room/${roomId}`);
  await enterIdentity(page, first, last);
  await waitForRoomReady(page);
  return page;
}

/** The document as the CRDT holds it, via the visible Monaco model. */
export function readEditor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.querySelector(".monaco-editor");
    // The view-lines node is the rendered content; the accessibility mirror is a sibling.
    const lines = el?.querySelectorAll(".view-line") ?? [];
    return [...lines].map((l) => l.textContent ?? "").join("\n");
  });
}

/**
 * INVARIANT: focus Monaco by clicking `.view-lines`, never its hidden `textarea`. Clicking the
 * textarea appears to work — select-all even takes effect — but the subsequent keystrokes do not
 * reach the model, so the document ends up EMPTY and the only symptom is a disabled Save button
 * and a Run that does nothing.
 */
async function focusEditor(page: Page) {
  await page.locator(".monaco-editor .view-lines").first().click();
}

export async function replaceEditorContent(page: Page, text: string) {
  await focusEditor(page);
  await page.keyboard.press("ControlOrMeta+KeyA");
  await page.keyboard.type(text);
  // Post-condition, so a silent focus failure fails loudly and immediately.
  await expect
    .poll(async () => normalise(await readEditor(page)), { timeout: 20_000 })
    .toContain(text.slice(0, 24));
}

export async function clearEditor(page: Page) {
  await focusEditor(page);
  await page.keyboard.press("ControlOrMeta+KeyA");
  await page.keyboard.press("Delete");
  await expect
    .poll(async () => (await readEditor(page)).trim().length, { timeout: 20_000 })
    .toBe(0);
}

/** Inserts a large body in one operation; typing it character by character takes minutes. */
export async function insertLargeContent(page: Page, text: string) {
  await focusEditor(page);
  await page.keyboard.press("ControlOrMeta+KeyA");
  await page.keyboard.insertText(text);
  await expect
    .poll(async () => (await readEditor(page)).length, { timeout: 30_000 })
    .toBeGreaterThan(1000);
}

/** Assert on a run's OUTPUT, never the transient "Running…" caption — a warm run beats the poll. */
export async function runAndWaitForOutput(page: Page, expected: RegExp) {
  await page.getByRole("button", { name: /^run/i }).first().click();
  await expect(page.getByText(expected).first()).toBeVisible({ timeout: 45_000 });
}
