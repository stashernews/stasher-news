-- One-time reconcile for the 2026-09-14 dist #2 sweep incident: the ops sweep
-- failed after all payouts were SENT, and the old code flipped the whole
-- distribution to FAILED. Distribution status now means "user payouts settled"
-- (a sweep outcome never changes it), so repair any row in that shape. Payout-
-- failed rows are left alone (their status is accurate and they need manual
-- recovery). Idempotent.
UPDATE "RewardDistribution" d
SET status = 'COMPLETE',
    "completedAt" = COALESCE(d."completedAt", NOW())
WHERE d.status = 'FAILED'
  AND d."opsSweepState" = 'FAILED'
  AND NOT EXISTS (
    SELECT 1 FROM "RewardPayout" p
    WHERE p."distributionId" = d.id AND p.state <> 'SENT'
  );
