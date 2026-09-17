import { Registry, Gauge, Counter, Histogram } from 'prom-client'
import { getNextRewardsPool } from '@/lib/rewardsPool'

// Prometheus metrics registry (Task D7). One Registry instance shared by every
// in-process caller; the /metrics endpoint reads register.metrics().
//
// MULTI-PROCESS TOPOLOGY: the app (Next.js) and worker (pg-boss) run in
// separate containers / Node processes. prom-client registries are
// process-local, so a gauge set by the worker does NOT appear on the app's
// /metrics and vice versa. Two consequences:
//
//   1. Each process that wants to be scraped must serve its own /metrics
//      (the app does at GET /metrics; a future worker sidecar can mirror it).
//      The Prometheus scraper aggregates both targets with distinct `job`
//      labels. This is the standard Node multi-process pattern.
//
//   2. The DB-backed subset (pending tips, latest distribution status,
//      pg-boss failed count, ops earmark, health gauges, rewards wallet
//      balance) is refreshed from the database on every scrape —
//      collectDBBackedMetrics for the cluster-wide counters and
//      collectHealthGauges for the HealthSnapshot bridge row (healthProbe and
//      the rewards signer write it from the worker process; see
//      HEALTH_STALE_MS below) — so those gauges reflect cluster-wide state on
//      whichever process serves /metrics regardless of which process produced
//      the underlying rows. The remaining signals (reorg counter, job-duration
//      histogram) stay process-local.
//
// All monetary gauges carry piconeros (1e-12 XMR). prom-client serializes JS
// numbers, so BigInts are coerced via Number() — exact up to ~9e15 piconeros
// (~9000 XMR), well above any realistic wallet balance; above that the gauge
// loses sub-piconero precision but never overflows.

const register = new Registry()
register.setDefaultLabels({ app: 'stashernews' })

export const moneroPendingTips = new Gauge({
  name: 'monero_pending_tips',
  help: 'ObservedTip rows currently in PENDING state (awaiting 0-conf webhook or reconcilePendingTips recovery)',
  registers: [register]
})

export const moneroRewardsWalletBalancePiconeros = new Gauge({
  name: 'monero_rewards_wallet_balance_piconeros',
  help: 'Platform rewards hot-wallet unlocked balance in piconeros (1e-12 XMR), refreshed by sendPayouts / sweepOpsEarmark (all signer accounts)',
  registers: [register]
})

export const moneroDistributionStatus = new Gauge({
  name: 'monero_distribution_status',
  help: 'Latest RewardDistribution status: 0=PENDING, 1=SENDING, 2=COMPLETE, 3=FAILED',
  registers: [register]
})

export const moneroWebhooksReceivedTotal = new Counter({
  name: 'monero_webhooks_received_total',
  help: 'lws tx-confirmation webhooks received at POST /api/monero/webhook',
  registers: [register]
})

export const moneroTipsRecoveredTotal = new Counter({
  name: 'monero_tips_recovered_total',
  help: 'Tips recovered by reconcilePendingTips (each = a missed lws 0-conf webhook)',
  registers: [register]
})

export const moneroTipsExpiredTotal = new Counter({
  name: 'monero_tips_expired_total',
  help: 'Tips expired by reconcilePendingTips after PENDING_EXPIRY_MS (abandoned checkouts)',
  registers: [register]
})

export const moneroJobDurationSeconds = new Histogram({
  name: 'monero_job_duration_seconds',
  help: 'pg-boss worker job execution duration in seconds (observed in the worker process)',
  labelNames: ['job'],
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 120, 300],
  registers: [register]
})

export const moneroLwsUp = new Gauge({
  name: 'monero_lws_up',
  help: 'monero-lws wallet endpoint reachability (1=up, 0=down) from the healthProbe worker',
  registers: [register]
})

export const moneroMonerodUp = new Gauge({
  name: 'monero_monerod_up',
  help: 'monerod daemon reachability (1=up, 0=down) from the healthProbe worker',
  registers: [register]
})

export const moneroMonerodHeight = new Gauge({
  name: 'monero_monerod_height',
  help: 'monerod chain height reported by the healthProbe worker',
  registers: [register]
})

export const moneroReorgsTotal = new Counter({
  name: 'monero_reorgs_total',
  help: 'Monero chain reorganizations detected (chain-height regression) by createReorgDetector',
  registers: [register]
})

export const moneroOpsPendingPiconeros = new Gauge({
  name: 'monero_ops_pending_piconeros',
  help: 'Pending ops earmark: unswept carry on the latest RewardDistribution plus this cycle\'s ops-earmarked inflow (lib/rewardsPool.js pendingSweepPiconeros)',
  registers: [register]
})

export const workerPgjobsFailedTotal = new Gauge({
  name: 'worker_pgjobs_failed_total',
  help: 'pg-boss jobs currently in the failed state (queried at scrape time; a failed-job snapshot, not a monotonic counter)',
  registers: [register]
})

export { register }

const DISTRIBUTION_STATUS = { PENDING: 0, SENDING: 1, COMPLETE: 2, FAILED: 3 }

// Refresh the DB-backed gauges from cluster-wide state. Called by /metrics on
// every scrape so the app process exposes authoritative pending-tip /
// distribution / pg-boss-failed counts regardless of which process produced
// them. Errors are swallowed so a transient DB hiccup never 500s the scrape;
// the previous gauge value is retained.
export async function collectDBBackedMetrics (models) {
  if (!models) return
  try {
    const pending = await models.observedTip.count({ where: { state: 'PENDING' } })
    moneroPendingTips.set(pending)
  } catch { /* DB unavailable — retain last value */ }
  try {
    const [row] = await models.$queryRaw`
      SELECT COUNT(*) FILTER (WHERE state = 'failed')::int AS failed
      FROM pgboss.job`
    workerPgjobsFailedTotal.set(row?.failed ?? 0)
  } catch { /* DB unavailable */ }
  try {
    const latest = await models.rewardDistribution.findFirst({ orderBy: { periodEnd: 'desc' } })
    if (latest) moneroDistributionStatus.set(DISTRIBUTION_STATUS[latest.status] ?? 0)
  } catch { /* DB unavailable */ }
  try {
    // Mirrors the literal ops allocation in lib/rewardsPool.js
    // (pendingSweepPiconeros = unswept carry + this cycle's ops earmark);
    // test/api/resolvers/rewardsWallet.test.js asserts the resolver and this
    // gauge agree.
    const pool = await getNextRewardsPool(models)
    moneroOpsPendingPiconeros.set(Number(pool.pendingSweepPiconeros))
  } catch { /* DB unavailable — retain last value */ }
}

// HEALTH_STALE_MS — how old a HealthSnapshot row may be before the app-side
// readers treat it as unseen. The healthProbe cron fires every 60s, so 5 min
// tolerates ~5 missed cycles (worker restart, transient DB blip) before the
// gauges flip to the safe "not known up" reading (0) and /api/health flips its
// lws/monerod fields back to null.
export const HEALTH_STALE_MS = 5 * 60 * 1000

function snapshotIsFresh (row) {
  return !!row?.updatedAt && (Date.now() - new Date(row.updatedAt).getTime()) < HEALTH_STALE_MS
}

// Refresh the health gauges from the HealthSnapshot bridge row (worker -> DB ->
// app). healthProbe (worker process) upserts its probe result every cycle and
// the rewards signer persists the post-send balance to the same row; this
// reader turns the row into gauges in the app process on every /metrics
// scrape. Stale-aware: a missing row, a stale row (older than HEALTH_STALE_MS),
// or a failed read all pin lws/monerod/height at 0 — the safe direction
// (0 = not known up). The balance gauge keeps LAST-KNOWN semantics instead:
// the signer only writes it on payout/sweep runs (weekly cadence), so ageing
// it out after 5 minutes would read "hot wallet empty" for most of the week —
// a row with a recorded balance always reports it. Errors are swallowed so a
// transient DB hiccup never 500s the scrape.
export async function collectHealthGauges (models) {
  let row = null
  if (models) {
    try {
      row = await models.healthSnapshot.findUnique({ where: { id: 1 } })
    } catch { /* DB unavailable — safe-baseline below */ }
  }
  if (snapshotIsFresh(row)) {
    moneroLwsUp.set(row.lws ? 1 : 0)
    moneroMonerodUp.set(row.monerod ? 1 : 0)
    moneroMonerodHeight.set(row.height || 0)
  } else {
    moneroLwsUp.set(0)
    moneroMonerodUp.set(0)
    moneroMonerodHeight.set(0)
  }
  if (row?.balancePiconeros != null && row?.balanceUpdatedAt != null) {
    try { moneroRewardsWalletBalancePiconeros.set(Number(row.balancePiconeros)) } catch { /* retain last value */ }
  }
}

export function __resetMetricsForTests () {
  moneroPendingTips.set(0)
  moneroRewardsWalletBalancePiconeros.set(0)
  moneroDistributionStatus.set(0)
  moneroWebhooksReceivedTotal.reset()
  moneroTipsRecoveredTotal.reset()
  moneroTipsExpiredTotal.reset()
  moneroLwsUp.set(0)
  moneroMonerodUp.set(0)
  moneroMonerodHeight.set(0)
  moneroReorgsTotal.reset()
  moneroOpsPendingPiconeros.set(0)
  workerPgjobsFailedTotal.set(0)
}
