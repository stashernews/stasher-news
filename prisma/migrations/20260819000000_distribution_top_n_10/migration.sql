-- Curator top-N 25 -> 10 (operator decision 2026-08-12): fewer, larger payouts
-- while the platform is small; the knob stays operator-tunable via the row.

ALTER TABLE "PlatformFeeConfig" ALTER COLUMN "distributionTopN" SET DEFAULT 10;

-- The PlatformFeeConfig row is the live operator singleton (id=1); schema
-- defaults only apply to fresh DBs, so update the existing row explicitly.
UPDATE "PlatformFeeConfig" SET "distributionTopN" = 10 WHERE id = 1;
