// Prisma CLI config only (migrate/generate/studio); the app's client is in
// src/lib/data/db.ts.
import { config } from "dotenv";
import { defineConfig } from "prisma/config";

// INVARIANT: must run before defineConfig — Prisma 7 auto-loads no .env file.
config({ path: ".env.local" });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // INVARIANT: DIRECT_URL (unpooled) — pgbouncer cannot hold migrate's advisory lock.
    url: process.env["DIRECT_URL"],
  },
});
