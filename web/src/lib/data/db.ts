// INVARIANT: server-only — never import from a "use client" module (pulls the driver and the
// connection string toward the browser bundle).

import { PrismaPg } from "@prisma/adapter-pg";
// Not "@prisma/client": Prisma 7 emits the client to schema.prisma's `output` path, and the
// package path yields a client with no models on it.
import { PrismaClient } from "../../../generated/prisma/client";


// Cached on globalThis so dev hot-reload does not open a fresh pool per edit until Neon
// refuses connections. A no-op in production.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    // DATABASE_URL is Neon's *pooled* endpoint; prisma.config.ts uses the direct one.
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
