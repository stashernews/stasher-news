-- Curator trust weighting (#6): reward-share multiplier floor.
ALTER TABLE "PlatformFeeConfig" ADD COLUMN "curatorTrustWeightFloor" DOUBLE PRECISION NOT NULL DEFAULT 1.0;
