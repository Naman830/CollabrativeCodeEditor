import js from "@eslint/js";
import globals from "globals";

// server/ had no lint at all until the audit — eight source files holding the whole snapshot,
// lifecycle and auth story, with no static gate. The point here is a gate, not a style war.
export default [
  { ignores: ["node_modules/**", "coverage/**"] },
  js.configs.recommended,
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      eqeqeq: ["error", "smart"],
      "no-console": "off",
      // Off deliberately, and this is the one rule choice here worth explaining: the sanitizers in
      // rooms/state.js exist precisely to match control characters and unpaired surrogates, which
      // cannot be stored in a Postgres text or jsonb column. Their regexes are the security
      // boundary, so flagging them inverts the intent. See the UNSTORABLE literal and
      // GUARD-01 in web/tests/unit/guards/source-encoding.test.ts, which checks those escapes are
      // still text rather than real bytes.
      "no-control-regex": "off",
    },
  },
  {
    files: ["tests/**/*.mjs", "vitest.config.mjs", "eslint.config.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
];
