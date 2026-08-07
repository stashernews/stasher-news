-- Drop dead aggregation tables (0 readers). AggRewards/AggRegistrations were
-- the legacy custodial-rewards rollups; the weekly rewards path now uses
-- RewardDistribution/RewardPayout. Earn/EarnType are intentionally KEPT
-- (Design B: earn-rows writes per-curator Earn rows from the distribution).
DROP TABLE IF EXISTS "AggRewards";
DROP TABLE IF EXISTS "AggRegistrations";
