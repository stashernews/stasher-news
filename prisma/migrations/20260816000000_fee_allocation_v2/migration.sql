-- StasherNews fee-allocation v2: donation split columns + new allocation defaults.
-- - PayIn.donationRewardsPct / FeeObservation.donationRewardsPct (nullable; consumed by later tasks)
-- - PlatformFeeConfig defaults updated for fresh DBs (boost 30, walletless 70, topN 25)

-- AlterTable
ALTER TABLE "FeeObservation" ADD COLUMN "donationRewardsPct" INTEGER;

-- AlterTable
ALTER TABLE "PayIn" ADD COLUMN "donationRewardsPct" INTEGER;

-- AlterTable
ALTER TABLE "PlatformFeeConfig" ALTER COLUMN "distributionTopN" SET DEFAULT 25,
ALTER COLUMN "walletlessTipRewardsPct" SET DEFAULT 70,
ALTER COLUMN "boostRewardsPct" SET DEFAULT 30;

-- The PlatformFeeConfig row is the live operator singleton (id=1); schema
-- defaults only apply to fresh DBs, so update the existing row explicitly.
UPDATE "PlatformFeeConfig" SET
  "boostRewardsPct" = 30,
  "walletlessTipRewardsPct" = 70,
  "distributionTopN" = 25
WHERE id = 1;
