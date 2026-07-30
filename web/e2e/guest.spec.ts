import { expect, test } from "@playwright/test";
import {
  clearEditor,
  createRoom,
  insertLargeContent,
  normalise,
  readEditor,
  replaceEditorContent,
  runAndWaitForOutput,
} from "./helpers";

test.describe("UF-01 guest solo: land, create, edit, run, save", () => {
  test("UF-01a a guest creates a python room and gets python starter code", async ({ page }) => {
    const roomId = await createRoom(page, "python");
    expect(roomId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // The language chosen at creation, not a per-user preference.
    await expect(page.getByText(/python/i).first()).toBeVisible();
    await expect(page.getByText("main.py").first()).toBeVisible();
    // Read from Monaco, not innerText — the accessibility mirror duplicates the text.
    expect(normalise(await readEditor(page))).toContain('print("Hello, world!")');
  });

  test("UF-01b each language gets its own starter and entry filename", async ({ page }) => {
    for (const [language, filename, needle] of [
      ["java", "Main.java", "public class Main"],
      ["cpp", "main.cpp", "#include <iostream>"],
    ] as const) {
      await createRoom(page, language);
      await expect(page.getByText(filename).first()).toBeVisible();
      expect(normalise(await readEditor(page))).toContain(needle);
    }
  });

  test("UF-01c the guest persistence chip promises nothing", async ({ page }) => {
    await createRoom(page, "python");
    // It must always promise less than the server guarantees.
    const chip = page.getByText(/guest|nothing is saved/i).first();
    await expect(chip).toBeVisible();
    expect(normalise(await chip.textContent() ?? "")).not.toMatch(/\bwill\b/i);
  });

  test("UF-01d running the entry file shows real output", async ({ page }) => {
    await createRoom(page, "python");
    await runAndWaitForOutput(page, /Hello, world!/);
    // The caption is sourced from the shared record, so it names the run's own file and language.
    await expect(page.getByText(/main\.py/).first()).toBeVisible();
  });

  test("UF-01e a runtime error is reported without pretending it is a crash", async ({ page }) => {
    await createRoom(page, "python");
    await replaceEditorContent(page, 'raise ValueError("boom")');
    await runAndWaitForOutput(page, /ValueError|boom/);
    // status "RE" with code 1 is an ordinary non-zero exit and must not earn an amber notice.
    await expect(page.getByText(/exceeded the .* memory limit/i)).toHaveCount(0);
  });

  test("UF-01f an empty entry file refuses to run, and says which file", async ({ page }) => {
    await createRoom(page, "python");
    await clearEditor(page);
    await page.getByRole("button", { name: /^run/i }).first().click();
    await expect(page.getByText(/nothing to run/i).first()).toBeVisible();
    await expect(page.getByText(/main\.py/).first()).toBeVisible();
  });
});

test.describe("UF-06 a dead room is refused before any socket opens", () => {
  test("UF-06a an unknown room id shows the closed screen and opens NO socket to the sync server", async ({
    page,
  }) => {
    const sockets: string[] = [];
    page.on("websocket", (ws) => sockets.push(ws.url()));

    await page.goto("/room/00000000-0000-0000-0000-000000000000");
    await expect(page.getByText(/closed|does not exist|no longer/i).first()).toBeVisible();

    // Mounting the editor is what opens the socket, which is precisely what the gate prevents.
    expect(sockets.filter((u) => u.includes(":8080"))).toHaveLength(0);
    await expect(page.locator(".monaco-editor")).toHaveCount(0);
  });

  test("UF-06b a malformed room id is treated as missing, not as a server error", async ({ page }) => {
    // /room/%25 used to be an unauthenticated 500 from a double decodeURIComponent.
    const response = await page.goto("/room/%25");
    expect(response?.status()).toBe(200);
  });
});

test.describe("SEC-30 the room route never ships Monaco from the server", () => {
  test("SEC-30a server HTML contains no monaco reference", async ({ page, request }) => {
    const roomId = await createRoom(page, "python");
    const html = await (await request.get(`/room/${roomId}`)).text();
    // A static import of CodeEditor/monacoLoader from a Server Component would 500 the route;
    // the status alone stopped being sufficient once the route started succeeding.
    expect(html).not.toContain("monaco");
  });

  test("SEC-30b the security headers are present on a room page", async ({ request }) => {
    const response = await request.get("/");
    const headers = response.headers();
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    // allow-popups, not same-origin: Clerk's OAuth popup postMessages through window.opener.
    expect(headers["cross-origin-opener-policy"]).toBe("same-origin-allow-popups");
    expect(headers["x-powered-by"]).toBeUndefined();
    expect(headers["content-security-policy-report-only"]).toContain("connect-src");
  });
});

test.describe("EC-20 the execute route's limits, through the real UI path", () => {
  test("EC-20a an oversized document is refused before it crosses the wire", async ({ page }) => {
    await createRoom(page, "python");
    // 70 KB of code: over MAX_CODE_BYTES, so useCodeRunner's pre-check writes the failure into
    // the shared map rather than posting it.
    await insertLargeContent(page, `# ${"x".repeat(70 * 1024)}`);
    await page.getByRole("button", { name: /^run/i }).first().click();
    await expect(page.getByText(/too large/i).first()).toBeVisible({ timeout: 30_000 });
  });
});
