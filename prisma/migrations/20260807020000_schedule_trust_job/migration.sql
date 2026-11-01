-- Schedule the nightly trust-graph recomputation job. Mirrors
-- 20260806093632_schedule_streak_job (pgboss.schedule row the fork's baseline
-- migrations never included). worker/trust.js computes UserSubTrust per ACTIVE
-- territory from confirmed ObservedTip/ObservedDownvote edges; live-tip
-- weighting consumes those rows. Runs nightly at 02:00
-- America/Chicago. Fresh installs self-seed via the deferred send in
-- worker/index.js (startAfter 24h) so the first run lands before the cron.
INSERT INTO pgboss.schedule (name, cron, timezone)
VALUES ('trust', '0 2 * * *', 'America/Chicago')
ON CONFLICT (name) DO NOTHING;
