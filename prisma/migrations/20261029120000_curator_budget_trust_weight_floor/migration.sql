-- Dynamic curator budget: trust-weight floor for the eligible tip volume T only.
-- Default 1.0 = T counts every tip at full weight (unchanged behavior).
ALTER TABLE "PlatformFeeConfig" ADD COLUMN "curatorBudgetTrustWeightFloor" DOUBLE PRECISION NOT NULL DEFAULT 1.0;
