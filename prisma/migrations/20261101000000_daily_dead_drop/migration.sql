-- The Daily Dead Drop: a site-wide discussion thread posted once a day by the
-- 'deaddrop' system account (USER_ID.deadDrop = 17226, lib/constants.js, the
-- id upstream reserved for its saloon bot). worker/dailyDeadDrop.js posts it
-- with no turf, so the home feed pins it globally; the job bootstraps the Pin
-- and day 1 itself, so nothing else needs seeding.

-- Seed the bot account at its reserved id. Fail loudly rather than silently
-- skip if either the id or the name already belongs to someone else: the job
-- would otherwise post as (or be blocked by) a real user.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "users" WHERE "id" = 17226 AND "name" IS DISTINCT FROM 'deaddrop') THEN
    RAISE EXCEPTION 'users id 17226 is taken by a non-deaddrop account';
  END IF;
  IF EXISTS (SELECT 1 FROM "users" WHERE "name" = 'deaddrop' AND "id" <> 17226) THEN
    RAISE EXCEPTION 'username deaddrop is taken by users id other than 17226';
  END IF;
END $$;

INSERT INTO "users" ("id", "name")
VALUES (17226, 'deaddrop')
ON CONFLICT DO NOTHING;

-- Fixed-id inserts do not advance the serial sequence: repeat the resync DO
-- block per 20260903000000_resync_id_sequences.
DO $$
DECLARE
  t RECORD;
  max_id BIGINT;
  seq TEXT;
BEGIN
  FOR t IN
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND EXISTS (
        SELECT 1 FROM information_schema.columns col
        WHERE col.table_schema = 'public'
          AND col.table_name = c.relname
          AND col.column_name = 'id')
  LOOP
    seq := pg_get_serial_sequence(format('public.%I', t.table_name), 'id');
    CONTINUE WHEN seq IS NULL;
    EXECUTE format('SELECT COALESCE(MAX(id), 0) FROM public.%I', t.table_name) INTO max_id;
    CONTINUE WHEN max_id = 0;
    PERFORM setval(seq::regclass, max_id);
  END LOOP;
END $$;

-- A new drop every day at 00:00 UTC.
INSERT INTO pgboss.schedule (name, cron, timezone, options) VALUES
  ('dailyDeadDrop', '0 0 * * *', 'UTC', '{"retryLimit":3,"retryDelay":60,"retryBackoff":true}')
ON CONFLICT (name) DO NOTHING;
