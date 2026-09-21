-- CreateTable
CREATE TABLE "monero_wall_rating" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "item_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "stars" INTEGER NOT NULL,

    CONSTRAINT "monero_wall_rating_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "monero_wall_rating_item_id_idx" ON "monero_wall_rating"("item_id");

-- CreateIndex
CREATE UNIQUE INDEX "monero_wall_rating_item_id_user_id_key" ON "monero_wall_rating"("item_id", "user_id");

-- AddForeignKey
ALTER TABLE "monero_wall_rating" ADD CONSTRAINT "monero_wall_rating_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monero_wall_rating" ADD CONSTRAINT "monero_wall_rating_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma cannot express CHECK constraints; enforce the 1-3 star scale at
-- the DB level as a backstop to the resolver validation.
ALTER TABLE "monero_wall_rating" ADD CONSTRAINT "monero_wall_rating_stars_check" CHECK ("stars" >= 1 AND "stars" <= 3);
