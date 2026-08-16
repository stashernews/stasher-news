-- DropIndex
DROP INDEX "FeeObservation_payInId_key";

-- CreateTable
CREATE TABLE "ObservedBountyReceipt" (
    "id" BIGSERIAL NOT NULL,
    "bountyId" BIGINT NOT NULL,
    "txHash" TEXT NOT NULL,
    "piconeros" BIGINT NOT NULL,
    "height" INTEGER,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ObservedBountyReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ObservedBountyReceipt_bountyId_idx" ON "ObservedBountyReceipt"("bountyId");

-- CreateIndex
CREATE UNIQUE INDEX "ObservedBountyReceipt_bountyId_txHash_key" ON "ObservedBountyReceipt"("bountyId", "txHash");

-- AddForeignKey
ALTER TABLE "ObservedBountyReceipt" ADD CONSTRAINT "ObservedBountyReceipt_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES "ObservedBounty"("id") ON DELETE CASCADE ON UPDATE CASCADE;
