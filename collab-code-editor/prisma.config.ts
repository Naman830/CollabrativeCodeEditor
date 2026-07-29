// Configuration for the Prisma CLI (migrate, generate, studio) — not for the
// running app, which builds its client in `app/lib/db.ts`.
//
// Two Prisma 7 changes make every older recipe wrong here:
//   1. Prisma no longer auto-loads .env files. Nothing below sees a variable
//      unless dotenv is called first, and the failure mode is a confusing
//      "no datasource URL" rather than a missing-file error.
//   2. The datasource URL moved out of schema.prisma and into this file.
import { config } from "dotenv";
import { defineConfig } from "prisma/config";

// Next's convention is .env.local; Prisma's default is .env. Loading .env.local
// explicitly keeps one file for both instead of asking anyone to remember which
// tool reads which. `config()` runs before defineConfig() below, so the
// process.env read is populated by then.
config({ path: ".env.local" });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // DIRECT_URL, not DATABASE_URL. Neon's pooled endpoint runs pgbouncer in
    // transaction mode, which cannot hold the session-level advisory lock
    // `prisma migrate` takes — migrations must use the unpooled host. The app
    // itself wants the opposite (see app/lib/db.ts).
    url: process.env["DIRECT_URL"],
  },
});
