-- CreateEnum
CREATE TYPE "RewardsWalletTxKind" AS ENUM ('PAYOUT', 'OPS_SWEEP', 'CONSOLIDATION');

-- CreateEnum
CREATE TYPE "RewardsWalletTxState" AS ENUM ('PREPARED', 'RELAYED', 'NOT_RELAYED');

-- CreateEnum
CREATE TYPE "RewardsReconciliationKind" AS ENUM ('CHECK', 'APPLY');

-- AlterTable
ALTER TABLE "BountyPayment" ADD COLUMN     "feeReceivedPiconeros" BIGINT,
ADD COLUMN     "feeRecipientAddress" TEXT,
ADD COLUMN     "feeSettlementNetworkFeePiconeros" BIGINT,
ADD COLUMN     "networkFeePiconeros" BIGINT,
ADD COLUMN     "recipientReceivedPiconeros" BIGINT;

-- AlterTable
ALTER TABLE "FeeObservation" ADD COLUMN     "rewardsPiconeros" BIGINT,
ADD COLUMN     "walletReceipt" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "bountyFeePiconeros" BIGINT;

-- AlterTable
ALTER TABLE "RewardDistribution" ADD COLUMN     "opsNetworkFeesAccountedPiconeros" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "RewardsWalletTransaction" (
    "id" BIGSERIAL NOT NULL,
    "network" "Network" NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "kind" "RewardsWalletTxKind" NOT NULL,
    "accountIndex" INTEGER NOT NULL,
    "distributionId" INTEGER,
    "principalPiconeros" BIGINT NOT NULL,
    "networkFeePiconeros" BIGINT NOT NULL,
    "metadata" JSONB NOT NULL,
    "state" "RewardsWalletTxState" NOT NULL DEFAULT 'PREPARED',
    "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "relayAttemptedAt" TIMESTAMP(3),
    "relayedAt" TIMESTAMP(3),

    CONSTRAINT "RewardsWalletTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardsWalletReconciliation" (
    "id" BIGSERIAL NOT NULL,
    "digest" TEXT NOT NULL,
    "kind" "RewardsReconciliationKind" NOT NULL,
    "network" "Network" NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "height" INTEGER NOT NULL,
    "blockHash" TEXT NOT NULL,
    "ledgerFingerprint" TEXT NOT NULL,
    "evidenceDigest" TEXT NOT NULL,
    "positiveDriftPiconeros" BIGINT NOT NULL,
    "report" JSONB NOT NULL,
    "backupReference" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "RewardsWalletReconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RewardsWalletTransaction_network_walletAddress_state_idx" ON "RewardsWalletTransaction"("network", "walletAddress", "state");

-- CreateIndex
CREATE INDEX "RewardsWalletTransaction_distributionId_idx" ON "RewardsWalletTransaction"("distributionId");

-- CreateIndex
CREATE UNIQUE INDEX "RewardsWalletTransaction_network_walletAddress_txHash_key" ON "RewardsWalletTransaction"("network", "walletAddress", "txHash");

-- CreateIndex
CREATE INDEX "RewardsWalletReconciliation_network_walletAddress_checkedAt_idx" ON "RewardsWalletReconciliation"("network", "walletAddress", "checkedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RewardsWalletReconciliation_digest_kind_key" ON "RewardsWalletReconciliation"("digest", "kind");

-- AddForeignKey
ALTER TABLE "RewardsWalletTransaction" ADD CONSTRAINT "RewardsWalletTransaction_distributionId_fkey" FOREIGN KEY ("distributionId") REFERENCES "RewardDistribution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =============================================================================
-- StasherNews rewards-wallet accounting repair (2026-10-05): money invariants
-- and the fail-closed legacy BOUNTY_FEE metadata backfill.
--
-- This file runs as ONE transaction (Prisma migrate, PostgreSQL): any RAISE
-- below aborts every statement above it, leaving the database untouched.
-- =============================================================================

-- Exact-money invariants. All amounts are piconeros (BigInt); these CHECKs are
-- the storage-layer backstop for the accounting helper's BigInt arithmetic.
ALTER TABLE "Item" ADD CONSTRAINT "Item_bounty_fee_nonnegative"
  CHECK ("bountyFeePiconeros" IS NULL OR "bountyFeePiconeros" >= 0);
ALTER TABLE "FeeObservation" ADD CONSTRAINT "FeeObservation_rewards_exact_bounds"
  CHECK ("rewardsPiconeros" IS NULL OR
    ("rewardsPiconeros" >= 0 AND "rewardsPiconeros" <= piconeros));
ALTER TABLE "RewardsWalletTransaction" ADD CONSTRAINT "RewardsWalletTransaction_amounts_nonnegative"
  CHECK ("principalPiconeros" >= 0 AND "networkFeePiconeros" >= 0);
ALTER TABLE "RewardsWalletTransaction" ADD CONSTRAINT "RewardsWalletTransaction_hash"
  CHECK ("txHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "RewardsWalletTransaction" ADD CONSTRAINT "RewardsWalletTransaction_self_principal"
  CHECK (kind <> 'CONSOLIDATION' OR "principalPiconeros" = 0);

-- -----------------------------------------------------------------------------
-- Legacy funding-time BOUNTY_FEE observations are escrow metadata, not hot-wallet
-- receipts: they were booked against the escrow funding transaction before any
-- hot-wallet receipt existed. Preserve their fee as the item's frozen terms,
-- then mark exactly those rows walletReceipt = false. Never a blanket feeType
-- update: only rows with the funding evidence below are flipped; anything else
-- is left to the fail-closed refusal, so a genuine receipt row is never
-- silently reclassified.
--
-- Identification predicate (also used by the later operator manifest
-- generation): a row is a legacy funding-time fee only with funding evidence —
-- the funding ObservedBounty row's txHash, its 'abandoned-<paymentId>'
-- pseudo-hash, or one of its ObservedBountyReceipt txHashes.
-- -----------------------------------------------------------------------------
CREATE TEMP TABLE "_rewards_legacy_bounty_fee" AS
SELECT f.id, f."postId", f.piconeros
FROM "FeeObservation" f
WHERE f."feeType" = 'BOUNTY_FEE'
  AND EXISTS (
    SELECT 1 FROM "ObservedBounty" b
    WHERE b."postId" = f."postId"
      AND (b."txHash" = f."txHash"
        OR f."txHash" = 'abandoned-' || b."paymentId"
        OR EXISTS (SELECT 1 FROM "ObservedBountyReceipt" r
          WHERE r."bountyId" = b.id AND r."txHash" = f."txHash")));

-- Conflicting terms for one item (two different matched fees, or a matched fee
-- that disagrees with an already-frozen value) are ambiguous: refuse rather
-- than picking one silently.
DO $$
DECLARE
  conflict text;
BEGIN
  SELECT string_agg(
           format('item %s: matched fees [%s], frozen value %s',
                  g."postId", g.amounts,
                  COALESCE(i."bountyFeePiconeros"::text, 'NULL')),
           '; ' ORDER BY g."postId")
    INTO conflict
  FROM (
    SELECT f."postId",
           string_agg(DISTINCT f.piconeros::text, ', ' ORDER BY f.piconeros::text) AS amounts,
           count(DISTINCT f.piconeros) AS distinct_amounts,
           min(f.piconeros) AS min_amount
    FROM "_rewards_legacy_bounty_fee" f
    GROUP BY f."postId"
  ) g
  JOIN "Item" i ON i.id = g."postId"
  WHERE g.distinct_amounts > 1
     OR (i."bountyFeePiconeros" IS NOT NULL AND i."bountyFeePiconeros" <> g.min_amount);
  IF conflict IS NOT NULL THEN
    RAISE EXCEPTION 'rewards accounting migration refused: conflicting bounty fee terms for %', conflict;
  END IF;
END $$;

-- Unresolved legacy positive BOUNTY_FEE rows have no funding evidence. Do not
-- declare them receipts or guess terms: an operator preflight/manifest must
-- resolve their IDs before deployment can proceed.
DO $$
DECLARE
  unresolved text;
BEGIN
  SELECT string_agg(
           format('id=%s postId=%s piconeros=%s', f.id, f."postId", f.piconeros),
           ', ' ORDER BY f.id)
    INTO unresolved
  FROM "FeeObservation" f
  WHERE f."feeType" = 'BOUNTY_FEE'
    AND f.piconeros > 0
    AND f.id NOT IN (SELECT id FROM "_rewards_legacy_bounty_fee");
  IF unresolved IS NOT NULL THEN
    RAISE EXCEPTION 'rewards accounting migration refused: unresolved legacy BOUNTY_FEE observation(s) without funding evidence: %', unresolved;
  END IF;
END $$;

-- Freeze the unambiguous fee on each item (NULL = unknown legacy terms; a
-- matched zero-fee abandonment pseudo-row freezes zero). Any existing non-NULL
-- value was proven equal in the conflict check above.
UPDATE "Item" i
SET "bountyFeePiconeros" = g.fee
FROM (
  SELECT f."postId", min(f.piconeros) AS fee
  FROM "_rewards_legacy_bounty_fee" f
  GROUP BY f."postId"
) g
WHERE i.id = g."postId"
  AND i."bountyFeePiconeros" IS NULL;

-- The preserved rows are historical evidence, not hot-wallet cash.
UPDATE "FeeObservation" f
SET "walletReceipt" = false
WHERE f.id IN (SELECT id FROM "_rewards_legacy_bounty_fee")
  AND f."walletReceipt" = true;

DROP TABLE "_rewards_legacy_bounty_fee";
