-- Schedule the nightly encrypted DB backup (dbBackup). Mirrors
-- 20260807160000_schedule_rewards_distributor / 20260807020000_schedule_trust_job.
-- Runs at 03:00 UTC nightly (off-peak, distinct from trust at 02:00 America/
-- Chicago and the weekly rewardsDistributor Monday 00:00 UTC). worker/index.js
-- keeps a deferred (24h) self-seed for fresh installs so a brand-new stack lands
-- a first backup before the cron; the handler does not self-requeue.
INSERT INTO pgboss.schedule (name, cron, timezone)
VALUES ('dbBackup', '0 3 * * *', 'UTC')
ON CONFLICT (name) DO NOTHING;
