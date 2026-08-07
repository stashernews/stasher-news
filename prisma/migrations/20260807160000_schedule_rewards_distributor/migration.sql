-- Schedule the weekly rewards distribution (rewardsDistributor). Replaces the
-- relative self-requeue (removed from worker/rewardsDistributor.js) with a fixed
-- Monday 00:00 UTC cron, so runs land on the exact moment the rewards resolver
-- counts down to (api/resolvers/rewards.js getActiveRewards:
-- (date_trunc('week', now() AT TIME ZONE 'UTC') + interval '1 week') AT TIME ZONE 'UTC').
-- Postgres date_trunc('week', …) starts Monday (extract(dow …) = 1), so cron
-- '0 0 * * 1' in TZ 'UTC' pairs exactly with the formula. Mirrors
-- 20260806093632_schedule_streak_job / 20260807020000_schedule_trust_job.
-- worker/index.js keeps a deferred (7d) self-seed for fresh installs so the
-- first payout lands after a week of inflow; it does not self-requeue.
INSERT INTO pgboss.schedule (name, cron, timezone)
VALUES ('rewardsDistributor', '0 0 * * 1', 'UTC')
ON CONFLICT (name) DO NOTHING;
