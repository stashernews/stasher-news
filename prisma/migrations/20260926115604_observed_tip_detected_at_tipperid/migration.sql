-- AlterTable
ALTER TABLE "StreakReward" RENAME CONSTRAINT "FlamePostCredit_pkey" TO "StreakReward_pkey";

-- CreateIndex
CREATE INDEX "ObservedTip_detectedAt_tipperId_idx" ON "ObservedTip"("detectedAt", "tipperId");
