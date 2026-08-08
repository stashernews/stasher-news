-- FeeObservation.payInId becomes nullable so wallet-less-tip ledger rows
-- (TIP_UNWALLETED) can be inserted without a PayIn.
ALTER TABLE "FeeObservation" ALTER COLUMN "payInId" DROP NOT NULL;

-- Drop the single-column @unique; the payIn.js lookup uses @@index([payInId])
-- (FeeObservation_payInId_idx), which is retained.
DROP INDEX IF EXISTS "FeeObservation_payInId_key";

-- PlatformFeeConfig: wallet-less author tips (TIP_UNWALLETED) allocation to
-- the curator rewards pool; remainder is the ops share. Default 50.
ALTER TABLE "PlatformFeeConfig" ADD COLUMN "walletlessTipRewardsPct" INTEGER NOT NULL DEFAULT 50;
