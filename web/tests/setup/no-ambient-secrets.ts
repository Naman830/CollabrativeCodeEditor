import { vi } from "vitest";

// INVARIANT: the unit tier is hermetic. Deleting these is what makes it runnable by a
// contributor with no secrets, and it is also load-bearing for correctness: several server
// modules read their knobs at *module load*, and the drift tier asserts the shipped defaults.
for (const key of [
  "DATABASE_URL",
  "DIRECT_URL",
  "CLERK_SECRET_KEY",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "PISTON_API_URL",
  "TRUSTED_PROXY_HOPS",
  "MEMBER_MIN_CONNECTED_MS",
  "ROOM_GRACE_MS",
  "ROOM_RESERVATION_MS",
  "SNAPSHOT_WRITE_LIMIT",
  "SNAPSHOT_WRITE_WINDOW_MS",
  "SNAPSHOT_FLUSH_MS",
  "DB_CONNECT_TIMEOUT_MS",
]) {
  delete process.env[key];
}

// A unit test that reaches the network is a bug in the test, not a flake to retry.
// Files that legitimately need fetch (the execute route) stub it themselves.
vi.stubGlobal("fetch", () => {
  throw new Error("unit tests must not hit the network");
});
