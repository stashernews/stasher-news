-- AlterTable
ALTER TABLE "PlatformFeeConfig" ALTER COLUMN "territoryMonthlyPiconeros" SET DEFAULT 20000000000,
ALTER COLUMN "territoryYearlyPiconeros" SET DEFAULT 200000000000,
ALTER COLUMN "territoryOncePiconeros" SET DEFAULT 1000000000000;

-- existing installs keep the old singleton row unless we update it
UPDATE "PlatformFeeConfig" SET
  "territoryMonthlyPiconeros" = 20000000000,
  "territoryYearlyPiconeros" = 200000000000,
  "territoryOncePiconeros" = 1000000000000
WHERE id = 1;
