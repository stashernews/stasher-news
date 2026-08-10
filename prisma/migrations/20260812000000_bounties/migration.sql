-- A-13 bounties Phase A: schema foundation.
-- - PostType + BOUNTY, FeeType + BOUNTY_FEE/BOUNTY_ROLLOVER
-- - Item bounty lifecycle columns (bountyPiconeros/bountyStatus/bountyConfirmedAt)
-- - PlatformFeeConfig bounty fee config
-- - New tables: ObservedBounty (escrow funding webhook), BountyPidMap (payment_id
--   reverse map), BountyPayment (award/reclaim/rollover ledger)
-- - Backfill existing territories' postTypes with BOUNTY
--
-- Enum values are appended (never reordered). PG forbids USING a freshly added
-- enum value inside the same transaction ("unsafe use of new value ... must be
-- committed before they can be used"), so the DDL and the postTypes backfill run
-- in separate transactions; the backfill's WHERE clause makes it idempotent.

BEGIN;

-- AlterEnum (append-only)
ALTER TYPE "PostType" ADD VALUE 'BOUNTY';

-- AlterEnum (append-only)
ALTER TYPE "FeeType" ADD VALUE 'BOUNTY_FEE';
ALTER TYPE "FeeType" ADD VALUE 'BOUNTY_ROLLOVER';

-- CreateEnum
CREATE TYPE "BountyStatus" AS ENUM ('UNFUNDED', 'PENDING_FUNDING', 'DETECTED', 'FUNDED', 'EXPIRED', 'AWARDED', 'REFUNDED', 'ROLLED_OVER');

-- CreateEnum
CREATE TYPE "BountyPayoutState" AS ENUM ('QUEUED', 'SENT', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "BountyPayoutKind" AS ENUM ('AWARD', 'RECLAIM', 'ROLLOVER');

-- AlterTable: Item bounty lifecycle (UNFUNDED posts are invisible until funding confirms)
ALTER TABLE "Item" ADD COLUMN "bountyPiconeros" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Item" ADD COLUMN "bountyStatus" "BountyStatus" NOT NULL DEFAULT 'UNFUNDED';
ALTER TABLE "Item" ADD COLUMN "bountyConfirmedAt" TIMESTAMP(3);

-- AlterTable: PlatformFeeConfig bounty fee config
ALTER TABLE "PlatformFeeConfig" ADD COLUMN "bountyFeeMinPiconeros" BIGINT NOT NULL DEFAULT 10000000000;
ALTER TABLE "PlatformFeeConfig" ADD COLUMN "bountyFeePct" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "PlatformFeeConfig" ADD COLUMN "bountyExpiryDays" INTEGER NOT NULL DEFAULT 30;

-- CreateTable
CREATE TABLE "ObservedBounty" (
    "id" BIGSERIAL NOT NULL,
    "txHash" TEXT NOT NULL,
    "postId" INTEGER NOT NULL,
    "payerId" INTEGER,
    "recipientAccountId" INTEGER NOT NULL,
    "paymentId" TEXT NOT NULL,
    "piconeros" BIGINT NOT NULL,
    "height" INTEGER,
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "state" "ObservedState" NOT NULL DEFAULT 'DETECTED',
    "webhookEventId" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "ObservedBounty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BountyPidMap" (
    "paymentId" TEXT NOT NULL,
    "postId" INTEGER NOT NULL,
    "nonce" BIGINT NOT NULL,
    "userId" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "BountyPidMap_pkey" PRIMARY KEY ("paymentId")
);

-- CreateTable
CREATE TABLE "BountyPayment" (
    "id" SERIAL NOT NULL,
    "itemId" INTEGER NOT NULL,
    "winnerUserId" INTEGER NOT NULL,
    "piconeros" BIGINT NOT NULL,
    "feePiconeros" BIGINT NOT NULL DEFAULT 0,
    "recipientAddress" TEXT NOT NULL,
    "kind" "BountyPayoutKind" NOT NULL DEFAULT 'AWARD',
    "txHash" TEXT,
    "feeTxHash" TEXT,
    "height" INTEGER,
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "state" "BountyPayoutState" NOT NULL DEFAULT 'QUEUED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "BountyPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ObservedBounty_postId_idx" ON "ObservedBounty"("postId");

-- CreateIndex
CREATE INDEX "ObservedBounty_state_confirmedAt_idx" ON "ObservedBounty"("state", "confirmedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ObservedBounty_txHash_paymentId_key" ON "ObservedBounty"("txHash", "paymentId");

-- CreateIndex
CREATE INDEX "BountyPayment_itemId_idx" ON "BountyPayment"("itemId");

-- CreateIndex
CREATE INDEX "BountyPayment_state_idx" ON "BountyPayment"("state");

-- AddForeignKey (ON DELETE RESTRICT ON UPDATE CASCADE matches ObservedDownvote/ObservedTip)
ALTER TABLE "ObservedBounty" ADD CONSTRAINT "ObservedBounty_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ObservedBounty" ADD CONSTRAINT "ObservedBounty_recipientAccountId_fkey" FOREIGN KEY ("recipientAccountId") REFERENCES "MoneroAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BountyPayment" ADD CONSTRAINT "BountyPayment_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BountyPayment" ADD CONSTRAINT "BountyPayment_winnerUserId_fkey" FOREIGN KEY ("winnerUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;

-- Backfill (separate transaction: 'BOUNTY' must be committed before it can be used).
BEGIN;

UPDATE "Sub" SET "postTypes" = array_append("postTypes", 'BOUNTY')
WHERE NOT ('BOUNTY' = ANY("postTypes"));

COMMIT;
