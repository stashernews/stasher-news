-- Cron-owned recurrence for the 90-day stale-draft sweep.
-- Mirrors 20260823000000_schedule_abandon_fee_items: a schedule row keeps the
-- chain alive — a permanently-failed run self-heals at the next cron tick.
-- Cadence: hourly (the 90-day cutoff makes sub-hourly sweeps pointless).
INSERT INTO pgboss.schedule (name, cron, timezone, options) VALUES
  ('abandonStaleDrafts', '0 * * * *', 'UTC', '{"retryLimit":3,"retryDelay":30,"retryBackoff":true}')
ON CONFLICT (name) DO NOTHING;
