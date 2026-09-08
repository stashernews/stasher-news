-- Single-row HealthSnapshot table: the worker -> DB -> app health bridge.
--
-- The healthProbe worker (worker/healthProbe.js) upserts row id=1 with its last
-- lws/monerod/height probe result every 60s cycle, and the rewards signer
-- (api/monero/rewards.js setBalanceGauge) persists the post-send unlocked
-- balance to the same row. /api/metrics (lib/metrics.js collectHealthGauges)
-- and /api/health read it back in the app process with a 5-minute staleness
-- window (HEALTH_STALE_MS) — the worker and app run in separate containers, so
-- a DB row is the bridge the process-local lib/healthStatus singleton could
-- never provide.
--
-- Table only, no seed row: the first upsert creates id=1. The id is a fixed
-- @default(1), not a serial — no sequence to resync.
CREATE TABLE "HealthSnapshot" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "lws" BOOLEAN,
    "monerod" BOOLEAN,
    "height" INTEGER NOT NULL DEFAULT 0,
    "stalled" BOOLEAN NOT NULL DEFAULT false,
    "balancePiconeros" BIGINT,
    "balanceUpdatedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HealthSnapshot_pkey" PRIMARY KEY ("id")
);
