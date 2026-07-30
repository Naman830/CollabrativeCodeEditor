import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });

// INVARIANT: localhost, never 127.0.0.1. Clerk's dev instance only allows the former and the
// failure is silent — window.Clerk exists with loaded:false forever, so the landing page simply
// renders without its Sign in / Sign up buttons.
const PORT = Number(process.env.E2E_PORT ?? 3000);
export const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // Room lifetime is measured in seconds here (grace windows, the 60s membership threshold), so
  // the default 30s is too tight for the lifecycle specs.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  // A shared sync server means parallel workers would contend over room ids and presence.
  workers: 1,
  // Zero on purpose: a retry that goes green hides exactly the CRDT/presence races this suite
  // exists to catch. A flaky spec is a finding, not noise to paper over.
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chrome",
      use: {
        ...devices["Desktop Chrome"],
        // System Chrome rather than a Playwright build: ~/.cache/ms-playwright holds
        // chromium-1140/1228, which do not match what this Playwright version wants, and the
        // failure is a bare "Executable doesn't exist".
        channel: "chrome",
      },
    },
  ],
  // INVARIANT: start the sync server with ROOM_CREATE_LIMIT raised (e.g. 300) before running this
  // suite. It creates ~20 rooms in a couple of minutes, which trips the production default of
  // 10/min/IP — and the symptom is a room-creation timeout deep inside an unrelated spec, which
  // reads exactly like a product bug. See docs/TESTING.md.
  //
  // The three services are started by hand (see docs/TESTING.md): Piston needs docker on the
  // `default` context, and reusing an already-running dev server keeps the suite fast.
  webServer: process.env.E2E_START_SERVER
    ? {
        command: "npm run dev",
        url: BASE_URL,
        reuseExistingServer: true,
        timeout: 120_000,
      }
    : undefined,
});
