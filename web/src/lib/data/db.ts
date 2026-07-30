// The one place the app learns about Postgres.
//
// Only one thing is ever stored: the snapshot written when a room dies. Nothing
// on the live editing path touches this module — sync stays in memory, Save
// stays local, and the Run limiter stays in-process (a per-request round trip
// on the execute path would be a worse trade than its documented approximation).
//
// Server-only. This must never be imported from a "use client" module: the
// import would pull the database driver — and the connection string — toward the
// browser bundle. `lib/collab/clerkIdentity.ts` is the client-side boundary; this
// is the server-side one.

import { PrismaPg } from "@prisma/adapter-pg";
// Relative, not aliased: `generated/` is machine-written and sits outside src/.
import { PrismaClient } from "../../../generated/prisma/client";

// Not "@prisma/client". Prisma 7's `prisma-client` generator emits the client
// into the path named by `output` in schema.prisma, and importing the old
// package path yields a client with no models on it.
//
// The adapter is not optional either. Prisma 7 removed `datasourceUrl` and
// `datasources` from the constructor: a driver adapter is now *required* unless
// you go through Prisma Accelerate, so the connection string reaches the client
// through PrismaPg rather than through any Prisma-managed engine.

/**
 * Next's dev server re-evaluates modules on every edit, and each evaluation
 * would otherwise construct a fresh client with a fresh connection pool. Neon
 * starts refusing connections after a dozen or so saves, which reads like a
 * database outage rather than a hot-reload artefact. Caching on globalThis is
 * the documented escape: the global survives module re-evaluation.
 *
 * Production evaluates each module once, so the cache is a no-op there.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    // DATABASE_URL is Neon's *pooled* endpoint, the opposite of what
    // prisma.config.ts uses. Vercel runs many short-lived instances that each
    // open their own pool, so connections have to be shared server-side by
    // pgbouncer or the project's connection ceiling is gone in a few requests.
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
