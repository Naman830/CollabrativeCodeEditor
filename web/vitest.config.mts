import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// `@/` must be replicated here: vitest does not read tsconfig paths on its own.
const alias = { "@": fileURLToPath(new URL("./src", import.meta.url)) };

const setupFiles = ["tests/setup/no-ambient-secrets.ts"];

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit-node",
          environment: "node",
          setupFiles,
          include: ["tests/unit/**/*.test.ts"],
          exclude: ["tests/unit/**/*.dom.test.ts", "tests/unit/drift/**"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "unit-dom",
          environment: "jsdom",
          setupFiles,
          include: ["tests/unit/**/*.dom.test.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "drift",
          environment: "node",
          setupFiles,
          include: ["tests/unit/drift/**/*.test.ts"],
          // The drift tier re-requires server modules under different env to prove a
          // divergence, and those modules read process.env at load and hold module-level
          // registries — so it needs a fresh process per file, not a reused worker thread.
          pool: "forks",
        },
      },
    ],
  },
});
