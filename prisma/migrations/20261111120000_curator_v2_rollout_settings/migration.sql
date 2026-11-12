-- Curator rewards: pay up to 20 curators, and require curator accounts to be
-- at least 7 days old at the end of the period.
ALTER TABLE "PlatformFeeConfig" ADD COLUMN "curatorMinAccountAgeDays" INTEGER NOT NULL DEFAULT 7;
ALTER TABLE "PlatformFeeConfig" ALTER COLUMN "distributionTopN" SET DEFAULT 20;

-- Schema defaults only apply to fresh DBs, so update the live singleton row.
UPDATE "PlatformFeeConfig" SET "distributionTopN" = 20 WHERE id = 1;
