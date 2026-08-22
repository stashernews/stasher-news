/*
  Warnings:

  - You are about to drop the column `baseCost` on the `Sub` table. All the data in the column will be lost.
  - You are about to drop the column `replyCost` on the `Sub` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[monero_payment_id]` on the table `PayIn` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "PayIn" ADD COLUMN     "monero_payment_id" TEXT;

-- AlterTable
ALTER TABLE "PlatformFeeConfig" ADD COLUMN     "max_turf_premium_piconeros" BIGINT NOT NULL DEFAULT 10000000000;

-- AlterTable
ALTER TABLE "Sub" DROP COLUMN "baseCost",
DROP COLUMN "replyCost",
ADD COLUMN     "comment_premium_piconeros" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "post_premium_piconeros" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ObservedSubFee" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tx_hash" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "pay_in_id" INTEGER NOT NULL,
    "subName" CITEXT NOT NULL,
    "owner_user_id" INTEGER NOT NULL,
    "piconeros" BIGINT NOT NULL,
    "height" INTEGER,
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "state" "ObservedState" NOT NULL,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMP(3),

    CONSTRAINT "ObservedSubFee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubFeePidMap" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payment_id" TEXT NOT NULL,
    "subName" CITEXT NOT NULL,
    "owner_user_id" INTEGER NOT NULL,
    "amount_piconeros" BIGINT NOT NULL,
    "webhook_event_id" INTEGER,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubFeePidMap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ObservedSubFee_pay_in_id_idx" ON "ObservedSubFee"("pay_in_id");

-- CreateIndex
CREATE INDEX "ObservedSubFee_subName_state_idx" ON "ObservedSubFee"("subName", "state");

-- CreateIndex
CREATE INDEX "ObservedSubFee_owner_user_id_idx" ON "ObservedSubFee"("owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ObservedSubFee_tx_hash_payment_id_key" ON "ObservedSubFee"("tx_hash", "payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "SubFeePidMap_payment_id_key" ON "SubFeePidMap"("payment_id");

-- CreateIndex
CREATE INDEX "SubFeePidMap_expires_at_idx" ON "SubFeePidMap"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "PayIn_monero_payment_id_key" ON "PayIn"("monero_payment_id");

-- AddForeignKey
ALTER TABLE "ObservedSubFee" ADD CONSTRAINT "ObservedSubFee_pay_in_id_fkey" FOREIGN KEY ("pay_in_id") REFERENCES "PayIn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
