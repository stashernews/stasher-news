-- CreateEnum
CREATE TYPE "ContributorPoolMode" AS ENUM ('OFF', 'SHADOW', 'ACTIVE');

-- CreateEnum
CREATE TYPE "ContributorDisqualifyReason" AS ENUM ('PLAGIARISM', 'AI_GENERATED', 'RULES', 'OTHER');

-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "contributorDisqualifiedAt" TIMESTAMP(3),
ADD COLUMN     "contributorDisqualifiedNote" TEXT,
ADD COLUMN     "contributorDisqualifiedReason" "ContributorDisqualifyReason";

-- AlterTable
ALTER TABLE "RewardDistribution" ADD COLUMN     "contributorBudgetPiconeros" BIGINT,
ADD COLUMN     "contributorDistributedPiconeros" BIGINT,
ADD COLUMN     "contributorParams" JSONB,
ADD COLUMN     "contributorPoolMode" "ContributorPoolMode",
ADD COLUMN     "contributorTargetPiconeros" BIGINT;

-- AlterTable
ALTER TABLE "PlatformFeeConfig" ADD COLUMN     "contributorBreadthTarget" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "contributorCombinedCapBps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "contributorCommentBonusBps" INTEGER NOT NULL DEFAULT 500,
ADD COLUMN     "contributorCommentBonusMax" INTEGER NOT NULL DEFAULT 8,
ADD COLUMN     "contributorLengthCapWords" INTEGER NOT NULL DEFAULT 1500,
ADD COLUMN     "contributorLengthFloor" DOUBLE PRECISION NOT NULL DEFAULT 0.6,
ADD COLUMN     "contributorLengthScaleWords" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "contributorMinAccountAgeDays" INTEGER NOT NULL DEFAULT 14,
ADD COLUMN     "contributorMinTipPiconeros" BIGINT NOT NULL DEFAULT 250000000,
ADD COLUMN     "contributorMinTrustedTippers" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "contributorPoolMode" "ContributorPoolMode" NOT NULL DEFAULT 'OFF',
ADD COLUMN     "contributorReciprocityDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "contributorReciprocityMult" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
ADD COLUMN     "contributorShareBps" INTEGER NOT NULL DEFAULT 1000,
ADD COLUMN     "contributorTipperCapBps" INTEGER NOT NULL DEFAULT 3334,
ADD COLUMN     "contributorTopN" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "contributorTrustThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.1,
ADD COLUMN     "contributorWinnerCapBps" INTEGER NOT NULL DEFAULT 4000;

