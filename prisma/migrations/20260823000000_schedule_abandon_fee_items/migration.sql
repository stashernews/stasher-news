-- Cron-owned recurrence for the 1-day PENDING_FEE abandonment sweep.
-- Mirrors 20260822000000_schedule_payment_observers: a schedule row keeps the
-- chain alive — a permanently-failed run self-heals at the next cron tick.
-- Cadence: hourly (the 1-day cutoff makes sub-hourly sweeps pointless).
INSERT INTO pgboss.schedule (name, cron, timezone, options) VALUES
  ('abandonFeeItems', '0 * * * *', 'UTC', '{"retryLimit":3,"retryDelay":30,"retryBackoff":true}')
ON CONFLICT (name) DO NOTHING;
