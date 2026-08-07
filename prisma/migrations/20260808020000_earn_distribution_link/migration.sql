-- AlterTable
ALTER TABLE "Earn" ADD COLUMN "distributionId" INTEGER;

-- CreateIndex
CREATE INDEX "Earn.distributionId_index" ON "Earn"("distributionId");

-- AddForeignKey
ALTER TABLE "Earn" ADD CONSTRAINT "Earn_distributionId_fkey" FOREIGN KEY ("distributionId") REFERENCES "RewardDistribution"("id") ON DELETE SET NULL ON UPDATE CASCADE;
