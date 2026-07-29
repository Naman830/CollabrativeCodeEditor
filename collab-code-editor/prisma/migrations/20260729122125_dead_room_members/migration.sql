/*
  Warnings:

  - You are about to drop the column `owner_user_id` on the `dead_rooms` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "dead_rooms_owner_user_id_died_at_idx";

-- AlterTable
ALTER TABLE "dead_rooms" DROP COLUMN "owner_user_id";

-- CreateTable
CREATE TABLE "dead_room_members" (
    "dead_room_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "dead_room_members_pkey" PRIMARY KEY ("user_id","dead_room_id")
);

-- AddForeignKey
ALTER TABLE "dead_room_members" ADD CONSTRAINT "dead_room_members_dead_room_id_fkey" FOREIGN KEY ("dead_room_id") REFERENCES "dead_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
