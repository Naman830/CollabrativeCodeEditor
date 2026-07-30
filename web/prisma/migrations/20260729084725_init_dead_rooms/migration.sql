-- CreateTable
CREATE TABLE "dead_rooms" (
    "id" UUID NOT NULL,
    "room_id" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "files" JSONB NOT NULL,
    "language" TEXT,
    "is_private" BOOLEAN NOT NULL DEFAULT false,
    "participants" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "died_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dead_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dead_rooms_room_id_key" ON "dead_rooms"("room_id");

-- CreateIndex
CREATE INDEX "dead_rooms_owner_user_id_died_at_idx" ON "dead_rooms"("owner_user_id", "died_at" DESC);
