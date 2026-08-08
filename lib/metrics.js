import { Registry, Gauge, Counter, Histogram } from 'prom-client'
import { getHealthStatus } from '@/lib/healthStatus'

// Prometheus metrics registry (Task D7). One Registry instance shared by every
// in-process caller; the /metrics endpoint reads register.metrics().
//
// MULTI-PROCESS TOPOLOGY: the app (Next.js) and worker (pg-boss) run in
// separate containers / Node processes. prom-client registries are
// process-local, so a gauge set by the worker (e.g. monerod_up from
// healthProbe) does NOT appear on the app's /metrics and vice versa. Two
// consequences:
//
//   1. Each process that wants to be scraped must serve its own /metrics
//      (the app does at GET /metrics; a future worker sidecar can mirror it).
//      The Prometheus scraper aggregates both targets with distinct `job`
//      labels. This is the standard Node multi-process pattern.
//
//   2. The DB-backed subset (pending tips, latest distribution status,
//      pg-boss failed count, ops earmark) is refreshed from the database on
//      every scrape via collectDBBackedMetrics below, so those gauges reflect
//      cluster-wide state on whichever process serves /metrics regardless of
//      which process produced the underlying rows. The worker-only signals
//      (rewards wallet unlocked balance from the signer, reorg counter,
//      job-duration histogram) stay process-local until a shared-store
//      bridge is added post-v1.
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
  help: 'Platform rewards hot-wallet unlocked balance in piconeros (1e-12 XMR), refreshed by sendPayouts / sweepOpsEarmark',
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
  help: 'monerod daemon reachability via lws getDaemonStatus (1=up, 0=down) from the healthProbe worker',
  registers: [register]
})

export const moneroMonerodHeight = new Gauge({
  name: 'monero_monerod_height',
  help: 'monerod chain height reported by lws getDaemonStatus',
  registers: [register]
})

export const moneroReorgsTotal = new Counter({
  name: 'monero_reorgs_total',
  help: 'Monero chain reorganizations detected (chain-height regression) by createReorgDetector',
  registers: [register]
})

export const moneroOpsPendingPiconeros = new Gauge({
  name: 'monero_ops_pending_piconeros',
  help: 'Undistributed ops earmark (opsAvailablePiconeros - opsSweptPiconeros) on the latest RewardDistribution',
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
    if (latest) {
      moneroDistributionStatus.set(DISTRIBUTION_STATUS[latest.status] ?? 0)
      const opsPending = BigInt(latest.opsAvailablePiconeros ?? 0) - BigInt(latest.opsSweptPiconeros ?? 0)
      moneroOpsPendingPiconeros.set(Number(opsPending))
    }
  } catch { /* DB unavailable */ }
}

// Refresh the in-process health gauges from lib/healthStatus. In the worker
// process healthProbe populates these; in the app process they stay at the
// null baseline (lws=0, monerod=0, height=0) until a cross-process bridge is
// wired, so /metrics on the app reflects "no worker-side probe seen here".
export function collectHealthGauges () {
  const s = getHealthStatus()
  moneroLwsUp.set(s.lws ? 1 : 0)
  moneroMonerodUp.set(s.monerod ? 1 : 0)
  moneroMonerodHeight.set(s.height || 0)
}

export function __resetMetricsForTests () {
  moneroPendingTips.set(0)
  moneroRewardsWalletBalancePiconeros.set(0)
  moneroDistributionStatus.set(0)
  moneroWebhooksReceivedTotal.reset()
  moneroLwsUp.set(0)
  moneroMonerodUp.set(0)
  moneroMonerodHeight.set(0)
  moneroReorgsTotal.reset()
  moneroOpsPendingPiconeros.set(0)
  workerPgjobsFailedTotal.set(0)
}
