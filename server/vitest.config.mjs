import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.mjs"],
          // Every module here holds module-level mutable state (the docs registry, the limiter
          // map, the room-state map, snapshotQueue's queue, clerk's warnedOnce) and several read
          // process.env at load. A fresh process per file is the only clean isolation.
          pool: "forks",
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.mjs"],
          pool: "forks",
          testTimeout: 60_000,
          hookTimeout: 60_000,
          retry: 0,
        },
      },
    ],
  },
});
