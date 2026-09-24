-- Quest rework schedules (spec §4.5): the streak evaluation moves to 00:10 UTC
-- and the completion sweep runs every 5 minutes. Cron-owned pgboss.schedule
-- rows (a failed run self-heals at the next cron tick).
UPDATE pgboss.schedule SET cron = '10 0 * * *', timezone = 'UTC', updated_on = now() WHERE name = 'streak';

INSERT INTO pgboss.schedule (name, cron, timezone, created_on, updated_on)
VALUES ('questSweep', '*/5 * * * *', 'UTC', now(), now())
ON CONFLICT (name) DO UPDATE SET cron = EXCLUDED.cron, timezone = EXCLUDED.timezone, updated_on = now();
