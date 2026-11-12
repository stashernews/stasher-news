-- Curator rewards v2: share formula switch, accuracy/amount exponents, the
-- per-payment minimum tip, the shadow trust floor and the per-run share record.
CREATE TYPE "CuratorShareFormula" AS ENUM ('LEGACY', 'SHADOW', 'V2');

ALTER TABLE "PlatformFeeConfig"
ADD COLUMN     "curatorShareFormula" "CuratorShareFormula" NOT NULL DEFAULT 'LEGACY',
ADD COLUMN     "curatorAccuracyExponent" DOUBLE PRECISION NOT NULL DEFAULT 0.25,
ADD COLUMN     "curatorAmountExponent" DOUBLE PRECISION NOT NULL DEFAULT 0.25,
ADD COLUMN     "curatorMinTipPiconeros" BIGINT NOT NULL DEFAULT 200000000,
ADD COLUMN     "curatorShadowTrustWeightFloor" DOUBLE PRECISION DEFAULT 0.75;

ALTER TABLE "RewardDistribution"
ADD COLUMN     "curatorShareRecord" JSONB;
