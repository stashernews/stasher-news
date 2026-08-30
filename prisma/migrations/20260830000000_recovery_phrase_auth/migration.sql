-- AlterTable
ALTER TABLE "users" ADD COLUMN     "phrasePubkey" CHAR(64);

-- CreateTable
CREATE TABLE "auth_challenges" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "k1" CHAR(64) NOT NULL,
    "pubkey" TEXT,

    CONSTRAINT "auth_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "auth_challenges_k1_key" ON "auth_challenges"("k1");

-- CreateIndex
CREATE UNIQUE INDEX "users.phrasePubkey_unique" ON "users"("phrasePubkey");

