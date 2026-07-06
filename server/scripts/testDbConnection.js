require("dotenv").config();
const { prisma } = require("../prismaClient");

async function main() {
  const room = await prisma.room.create({
    data: { id: `smoke-test-${Date.now()}` },
  });
  console.log("Created:", room);

  const found = await prisma.room.findUnique({ where: { id: room.id } });
  console.log("Fetched:", found);

  await prisma.room.delete({ where: { id: room.id } });
  console.log("Deleted OK. Connection verified end-to-end.");
}

main()
  .catch((err) => {
    console.error("DB test failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
