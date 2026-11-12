-- Curator rewards v2: its own per-curator share cap (30%), so the per-tipper
-- cap on the budget's tip volume T (curatorTipCapShareBps) stays independent.
ALTER TABLE "PlatformFeeConfig" ADD COLUMN "curatorShareCapBps" INTEGER NOT NULL DEFAULT 3000;
