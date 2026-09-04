-- Resync every table's `id` serial sequence to MAX(id).
--
-- Migrations seed fixed-id rows (users 27=anon, 616=stasher, 4502=sn) with
-- explicit ids, which does NOT advance the serial sequences. On a fresh
-- database the serial then hands out already-taken ids and the insert fails
-- with 23505 — first collision: users id 27 (the 27th signup), later 616 and
-- 4502. prisma/seed.js does this resync for dev databases, but the VPS
-- prodmode boot chain never runs seed.js, so it must happen here.
--
-- Idempotent: safe to re-run. Any future migration that INSERTs explicit ids
-- must repeat this DO block (see AGENTS.md Key Gotchas).
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
      -- only tables that HAVE an id column: pg_get_serial_sequence RAISES
      -- 42703 (rather than returning NULL) for missing columns, and the
      -- schema has 15 composite-key tables without one (UserSubTrust, ...)
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
