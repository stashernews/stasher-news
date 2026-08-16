-- Convert the six self-requeuing money-observation chains to cron-owned
-- recurrence. A self-requeuing pg-boss chain that exhausts its retry budget
-- dies permanently (no cron, no requeue-on-failure, boot seed only fires when
-- the queue is empty) — demonstrated live 2026-08-16 when rewardsWalletObserver
-- died during a monerod outage and a paid downvote sat unattributed until a
-- manual worker restart. With a schedule row, a dead run self-heals at the
-- next cron tick. options jsonb is passed verbatim to send() for every
-- cron-created job (pg-boss timekeeper.onSendIt). bounties keeps retryLimit 0:
-- its payout dispatch is relay-before-persist with no CAS (plan-1 decision).
-- Cadences: observer 20s->60s (accepted: +<=40s fee-detection latency vs
-- 10-block finality); confirmFinalizer/healthProbe 60s; reconcilePendingTips
-- 120s (*/2); bounties 60s; webhookCleanup hourly. Mirrors
-- 20260807160000_schedule_rewards_distributor.
INSERT INTO pgboss.schedule (name, cron, timezone, options) VALUES
  ('rewardsWalletObserver', '* * * * *', 'UTC', '{"retryLimit":3,"retryDelay":30,"retryBackoff":true}'),
  ('confirmFinalizer', '* * * * *', 'UTC', '{"retryLimit":3,"retryDelay":30,"retryBackoff":true}'),
  ('reconcilePendingTips', '*/2 * * * *', 'UTC', '{"retryLimit":3,"retryDelay":30,"retryBackoff":true}'),
  ('bounties', '* * * * *', 'UTC', '{"retryLimit":0}'),
  ('healthProbe', '* * * * *', 'UTC', '{"retryLimit":3,"retryDelay":30,"retryBackoff":true}'),
  ('webhookCleanup', '0 * * * *', 'UTC', '{"retryLimit":3,"retryDelay":30,"retryBackoff":true}')
ON CONFLICT (name) DO NOTHING;
