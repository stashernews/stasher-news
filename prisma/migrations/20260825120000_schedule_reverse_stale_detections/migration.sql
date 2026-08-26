-- Schedule reverseStaleDetections (audit A-1 stale-DETECTED reversal): flips
-- DETECTED observations whose height is still NULL after
-- STALE_DETECTED_EXPIRY_MS (48h) to REORGED and reverses their provisional
-- effects. Every 10 min is far tighter than the 48h window needs and keeps the
-- reversal batch small. Cron-owned recurrence (no self-requeue) — mirrors
-- 20260822000000_schedule_payment_observers.
INSERT INTO pgboss.schedule (name, cron, timezone, options)
VALUES ('reverseStaleDetections', '*/10 * * * *', 'UTC', '{"retryLimit":3,"retryDelay":30,"retryBackoff":true}')
ON CONFLICT (name) DO NOTHING;
