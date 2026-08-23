-- Cron-owned recurrence for the owner-fee-leg reconcile backstop (missed lws
-- webhook callbacks). Mirrors 20260822000000_schedule_payment_observers: a
-- schedule row keeps the chain alive — a permanently-failed run self-heals at
-- the next cron tick. Cadence: hourly (legs have a 1-day abandonment window).
INSERT INTO pgboss.schedule (name, cron, timezone, options) VALUES
  ('reconcileOwnerFeeLegs', '0 * * * *', 'UTC', '{"retryLimit":3,"retryDelay":30,"retryBackoff":true}')
ON CONFLICT (name) DO NOTHING;
