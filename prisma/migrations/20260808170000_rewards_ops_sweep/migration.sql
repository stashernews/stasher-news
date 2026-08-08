-- Workstream B (hot-wallet ops sweep): track the ops share of each weekly
-- distribution separately from the curator rewards pool. The rewards
-- wallet receives all fees/inflows; the ops earmark (inflow minus the
-- curator rewards share) is swept out to the ops cold wallet each run.

-- CreateEnum
CREATE TYPE "OpsSweepState" AS ENUM ('NOT_SWEEPED', 'SWEPT', 'SKIPPED_LOCKED', 'FAILED');

-- AlterTable
ALTER TABLE "RewardDistribution" ADD COLUMN     "opsInflowPiconeros" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "opsRolledOverPiconeros" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "opsAvailablePiconeros" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "opsSweptPiconeros" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "opsSweepTxHash" TEXT,
ADD COLUMN     "opsSweepState" "OpsSweepState" NOT NULL DEFAULT 'NOT_SWEEPED';
