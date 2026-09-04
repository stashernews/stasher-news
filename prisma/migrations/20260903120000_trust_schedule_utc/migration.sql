-- Move the nightly trust-graph recomputation from America/Chicago (02:00
-- CDT/CST — DST-drifting: 07:00/08:00 UTC) to a fixed 02:00 UTC (operator
-- choice, 2026-09-03). The cron expression is unchanged; pg-boss interprets
-- it in the row's timezone column. Upsert (not bare UPDATE) so the row is
-- re-asserted to the intended state even if a prior seed ever drifted.
-- Idempotent: safe to re-run.
INSERT INTO pgboss.schedule (name, cron, timezone)
VALUES ('trust', '0 2 * * *', 'UTC')
ON CONFLICT (name) DO UPDATE SET cron = EXCLUDED.cron, timezone = EXCLUDED.timezone;
