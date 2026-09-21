-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "moneroWallEnabledAt" TIMESTAMP(3),
ADD COLUMN     "moneroWallPricePiconeros" BIGINT,
ADD COLUMN     "moneroWallRemovedAt" TIMESTAMP(3),
ADD COLUMN     "moneroWallThresholdPiconeros" BIGINT;

-- CreateIndex
CREATE INDEX "ObservedTip_postId_tipperId_state_idx" ON "ObservedTip"("postId", "tipperId", "state");

-- CreateIndex
CREATE INDEX "ObservedTip_postId_state_idx" ON "ObservedTip"("postId", "state");
