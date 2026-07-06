// Uses the pooled DATABASE_URL at runtime (via the pg driver adapter), since
// this connection serves many short-lived queries from the WS server.
// Migrations use the direct DIRECT_URL instead (see prisma.config.ts) because
// Neon's pooler runs PgBouncer in transaction mode, which doesn't support the
// session-level advisory locks Prisma Migrate needs.
const { PrismaClient } = require("./generated/prisma");
const { PrismaPg } = require("@prisma/adapter-pg");

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

module.exports = { prisma };
