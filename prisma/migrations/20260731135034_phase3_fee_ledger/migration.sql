-- CreateEnum
CREATE TYPE "FeeType" AS ENUM ('POSTING', 'TERRITORY_CREATE', 'TERRITORY_BILLING', 'TERRITORY_UNARCHIVE');

-- CreateEnum
CREATE TYPE "ItemFeeStatus" AS ENUM ('FEE_NOT_REQUIRED', 'PENDING_FEE', 'FEE_PAID');

-- CreateEnum
CREATE TYPE "SubBillingStatus" AS ENUM ('PAID', 'PENDING_FEE', 'LAPSED');

-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "feePayInId" INTEGER,
ADD COLUMN     "feeStatus" "ItemFeeStatus" NOT NULL DEFAULT 'FEE_NOT_REQUIRED';

-- AlterTable
ALTER TABLE "PayIn" ADD COLUMN     "moneroSubaddressMajor" INTEGER,
ADD COLUMN     "moneroSubaddressMinor" INTEGER;

-- AlterTable
ALTER TABLE "Sub" ADD COLUMN     "billingPayInId" INTEGER,
ADD COLUMN     "billingStatus" "SubBillingStatus" NOT NULL DEFAULT 'PAID';

-- CreateTable
CREATE TABLE "FeeObservation" (
    "id" BIGSERIAL NOT NULL,
    "txHash" TEXT NOT NULL,
    "payInId" INTEGER NOT NULL,
    "feeType" "FeeType" NOT NULL,
    "postId" INTEGER,
    "subName" CITEXT,
    "recipientMajor" INTEGER NOT NULL,
    "recipientMinor" INTEGER NOT NULL,
    "piconeros" BIGINT NOT NULL,
    "height" INTEGER,
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "state" "ObservedState" NOT NULL DEFAULT 'DETECTED',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "FeeObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FeeObservation_payInId_key" ON "FeeObservation"("payInId");

-- CreateIndex
CREATE INDEX "FeeObservation_payInId_idx" ON "FeeObservation"("payInId");

-- CreateIndex
CREATE INDEX "FeeObservation_feeType_state_idx" ON "FeeObservation"("feeType", "state");

-- CreateIndex
CREATE UNIQUE INDEX "FeeObservation_txHash_recipientMajor_recipientMinor_key" ON "FeeObservation"("txHash", "recipientMajor", "recipientMinor");

-- CreateIndex
CREATE UNIQUE INDEX "Item_feePayInId_key" ON "Item"("feePayInId");

-- CreateIndex
CREATE UNIQUE INDEX "Sub_billingPayInId_key" ON "Sub"("billingPayInId");

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_feePayInId_fkey" FOREIGN KEY ("feePayInId") REFERENCES "PayIn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sub" ADD CONSTRAINT "Sub_billingPayInId_fkey" FOREIGN KEY ("billingPayInId") REFERENCES "PayIn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeObservation" ADD CONSTRAINT "FeeObservation_payInId_fkey" FOREIGN KEY ("payInId") REFERENCES "PayIn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

