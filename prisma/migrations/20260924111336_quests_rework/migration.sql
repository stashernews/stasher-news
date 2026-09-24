-- CreateEnum
CREATE TYPE "QuestType" AS ENUM ('UPVOTE', 'BOOST', 'FIRST_RESPONDER', 'TURF');

-- CreateEnum
CREATE TYPE "StreakRewardType" AS ENUM ('POST', 'FREEZE', 'TURF_DISCOUNT');

-- AlterEnum: drop the legacy coin streak value. No code creates COIN rows
-- anymore (the badge is deleted); delete any left over before the type is
-- recreated without the value.
DELETE FROM "Streak" WHERE "type" = 'COIN';
BEGIN;
CREATE TYPE "StreakType_new" AS ENUM ('FLAME', 'VERIFIED');
ALTER TABLE "Streak" ALTER COLUMN "type" DROP DEFAULT;
ALTER TABLE "Streak" ALTER COLUMN "type" TYPE "StreakType_new" USING ("type"::text::"StreakType_new");
ALTER TYPE "StreakType" RENAME TO "StreakType_old";
ALTER TYPE "StreakType_new" RENAME TO "StreakType";
DROP TYPE "StreakType_old";
ALTER TABLE "Streak" ALTER COLUMN "type" SET DEFAULT 'FLAME';
COMMIT;

-- AlterTable: the ladder marker replaces the old 3/7 credit marker in place
-- (rename preserves values; both mean "highest level already granted").
ALTER TABLE "Streak" RENAME COLUMN "postCreditsGranted" TO "rewardLevel";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "noteQuests" BOOLEAN NOT NULL DEFAULT true;

-- Rename + generalize the ledger (FlamePostCredit -> StreakReward, typed).
ALTER TABLE "FlamePostCredit" RENAME TO "StreakReward";
ALTER TABLE "StreakReward" RENAME CONSTRAINT "FlamePostCredit_userId_fkey" TO "StreakReward_userId_fkey";
ALTER TABLE "StreakReward" ADD COLUMN "type" "StreakRewardType" NOT NULL DEFAULT 'POST';
DROP INDEX "FlamePostCredit_userId_consumedAt_expiresAt_idx";
DROP INDEX "FlamePostCredit_expiresAt_idx";

-- CreateTable
CREATE TABLE "QuestCompletion" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" INTEGER NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "quest" "QuestType" NOT NULL,

    CONSTRAINT "QuestCompletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuestCompletion_day_idx" ON "QuestCompletion"("day");

-- CreateIndex
CREATE UNIQUE INDEX "QuestCompletion_userId_day_quest_key" ON "QuestCompletion"("userId", "day", "quest");

-- CreateIndex
CREATE INDEX "StreakReward_userId_type_consumedAt_expiresAt_idx" ON "StreakReward"("userId", "type", "consumedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "StreakReward_expiresAt_idx" ON "StreakReward"("expiresAt");

-- AddForeignKey
ALTER TABLE "QuestCompletion" ADD CONSTRAINT "QuestCompletion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
