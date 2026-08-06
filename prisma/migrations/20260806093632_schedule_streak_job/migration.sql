-- Schedule the daily cowboy-hat streak maintenance job (computeStreaks).
-- Mirrors upstream stacker.news migration 20230522153900_schedule_jobs,
-- which the fork's baseline migration never included — without this row
-- streaks can neither extend nor be lost.
INSERT INTO pgboss.schedule (name, cron, timezone)
VALUES ('streak', '15 0 * * *', 'America/Chicago')
ON CONFLICT DO NOTHING;
