/* eslint-env jest */
import {
  register,
  collectDBBackedMetrics,
  collectHealthGauges,
  HEALTH_STALE_MS,
  __resetMetricsForTests,
  moneroPendingTips,
  moneroRewardsWalletBalancePiconeros,
  moneroDistributionStatus,
  moneroWebhooksReceivedTotal,
  moneroTipsRecoveredTotal,
  moneroTipsExpiredTotal,
  moneroJobDurationSeconds,
  moneroLwsUp,
  moneroMonerodUp,
  moneroMonerodHeight,
  moneroReorgsTotal,
  moneroOpsPendingPiconeros,
  workerPgjobsFailedTotal
} from '@/lib/metrics'

const ALL_NAMES = [
  'monero_pending_tips',
  'monero_rewards_wallet_balance_piconeros',
  'monero_distribution_status',
  'monero_webhooks_received_total',
  'monero_tips_recovered_total',
  'monero_tips_expired_total',
  'monero_job_duration_seconds',
  'monero_lws_up',
  'monero_monerod_up',
  'monero_monerod_height',
  'monero_reorgs_total',
  'monero_ops_pending_piconeros',
  'worker_pgjobs_failed_total'
]

beforeEach(() => {
  __resetMetricsForTests()
})

test('registry content type is the Prometheus exposition format', () => {
  expect(register.contentType).toBe('text/plain; version=0.0.4; charset=utf-8')
})

test('every required metric is registered', async () => {
  const exposition = await register.metrics()
  for (const name of ALL_NAMES) {
    expect(exposition).toContain(`# HELP ${name} `)
    expect(exposition).toContain(`# TYPE ${name} `)
  }
})

test('every metric is exported as a prom-client metric instance', () => {
  const metrics = [
    moneroPendingTips, moneroRewardsWalletBalancePiconeros, moneroDistributionStatus,
    moneroWebhooksReceivedTotal, moneroTipsRecoveredTotal, moneroTipsExpiredTotal, moneroJobDurationSeconds, moneroLwsUp,
    moneroMonerodUp, moneroMonerodHeight, moneroReorgsTotal,
    moneroOpsPendingPiconeros, workerPgjobsFailedTotal
  ]
  for (const m of metrics) {
    expect(m).toBeTruthy()
    expect(typeof m.name).toBe('string')
    expect(ALL_NAMES).toContain(m.name)
  }
})

test('a gauge set in-process appears in the exposition with its value', async () => {
  moneroMonerodHeight.set(3100000)
  expect(await valueOf('monero_monerod_height')).toBe(3100000)
})

test('counter increments accumulate (.inc and .inc(n))', async () => {
  moneroReorgsTotal.inc()
  moneroReorgsTotal.inc()
  moneroReorgsTotal.inc(4)
  expect(await valueOf('monero_reorgs_total')).toBe(6)
})

test('tip outcome counters accumulate (.inc(n))', async () => {
  moneroTipsRecoveredTotal.inc(3)
  moneroTipsExpiredTotal.inc()
  expect(await valueOf('monero_tips_recovered_total')).toBe(3)
  expect(await valueOf('monero_tips_expired_total')).toBe(1)
})

test('histogram observes per label and emits bucket/sum/count series', async () => {
  moneroJobDurationSeconds.labels('trust').observe(0.3)
  moneroJobDurationSeconds.labels('trust').observe(12)
  const exposition = await register.metrics()
  const bucketLine = exposition.split('\n').find(l => l.startsWith('monero_job_duration_seconds_bucket{le="1",'))
  expect(bucketLine).toBeDefined()
  expect(bucketLine).toContain('job="trust"')
  expect(bucketLine.endsWith(' 1')).toBe(true)
  const countLine = exposition.split('\n').find(l => l.startsWith('monero_job_duration_seconds_count{'))
  expect(countLine).toContain('job="trust"')
  expect(countLine.endsWith(' 2')).toBe(true)
})

// HealthSnapshot-shaped row as Prisma returns it (BigInt balance, Date stamps).
function snapshotRow (overrides = {}) {
  return {
    id: 1,
    lws: true,
    monerod: true,
    height: 3100000,
    stalled: false,
    balancePiconeros: 1234567890n,
    balanceUpdatedAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  }
}

function modelsWithRow (row) {
  return { healthSnapshot: { findUnique: jest.fn().mockResolvedValue(row) } }
}

test('HEALTH_STALE_MS is the exported 5-minute staleness window', () => {
  expect(HEALTH_STALE_MS).toBe(5 * 60 * 1000)
})

test('collectHealthGauges maps a fresh HealthSnapshot row to the gauges', async () => {
  const models = modelsWithRow(snapshotRow({ lws: true, monerod: true, height: 3100000 }))
  await collectHealthGauges(models)
  expect(models.healthSnapshot.findUnique).toHaveBeenCalledWith({ where: { id: 1 } })
  expect(await valueOf('monero_lws_up')).toBe(1)
  expect(await valueOf('monero_monerod_up')).toBe(1)
  expect(await valueOf('monero_monerod_height')).toBe(3100000)
})

test('collectHealthGauges maps a fresh lws-down row to lws 0 without zeroing monerod', async () => {
  await collectHealthGauges(modelsWithRow(snapshotRow({ lws: false, monerod: true, height: 3100000 })))
  expect(await valueOf('monero_lws_up')).toBe(0)
  expect(await valueOf('monero_monerod_up')).toBe(1)
  expect(await valueOf('monero_monerod_height')).toBe(3100000)
})

test('collectHealthGauges zeroes the gauges when the row is stale (older than HEALTH_STALE_MS)', async () => {
  const stale = new Date(Date.now() - HEALTH_STALE_MS - 1000)
  await collectHealthGauges(modelsWithRow(snapshotRow({ lws: true, monerod: true, updatedAt: stale })))
  expect(await valueOf('monero_lws_up')).toBe(0)
  expect(await valueOf('monero_monerod_up')).toBe(0)
  expect(await valueOf('monero_monerod_height')).toBe(0)
})

test('collectHealthGauges zeroes the gauges when the row is missing', async () => {
  await collectHealthGauges(modelsWithRow(null))
  expect(await valueOf('monero_lws_up')).toBe(0)
  expect(await valueOf('monero_monerod_up')).toBe(0)
  expect(await valueOf('monero_monerod_height')).toBe(0)
})

test('collectHealthGauges is a safe-baseline no-op without models and resolves', async () => {
  await expect(collectHealthGauges(undefined)).resolves.toBeUndefined()
  await expect(collectHealthGauges(null)).resolves.toBeUndefined()
  expect(await valueOf('monero_lws_up')).toBe(0)
  expect(await valueOf('monero_monerod_up')).toBe(0)
  expect(await valueOf('monero_monerod_height')).toBe(0)
})

test('collectHealthGauges zeroes the gauges (never throws) when the snapshot read fails', async () => {
  const models = { healthSnapshot: { findUnique: jest.fn().mockRejectedValue(new Error('db down')) } }
  await expect(collectHealthGauges(models)).resolves.toBeUndefined()
  expect(await valueOf('monero_lws_up')).toBe(0)
  expect(await valueOf('monero_monerod_up')).toBe(0)
  expect(await valueOf('monero_monerod_height')).toBe(0)
})

test('collectHealthGauges bridges the rewards wallet balance from a row that has one', async () => {
  await collectHealthGauges(modelsWithRow(snapshotRow({ balancePiconeros: 987654321n })))
  expect(await valueOf('monero_rewards_wallet_balance_piconeros')).toBe(987654321)
})

test('collectHealthGauges keeps serving a last-known balance even when the balance reading is old', async () => {
  // The signer only writes the balance on payout/sweep runs (weekly cadence);
  // ageing it out on HEALTH_STALE_MS would read "hot wallet empty" for most of
  // the week, so the balance keeps last-known semantics.
  const old = new Date(Date.now() - HEALTH_STALE_MS - 1000)
  await collectHealthGauges(modelsWithRow(snapshotRow({ balanceUpdatedAt: old, updatedAt: new Date() })))
  expect(await valueOf('monero_rewards_wallet_balance_piconeros')).toBe(1234567890)
})

test('collectHealthGauges leaves the balance gauge at baseline when the row has no balance reading', async () => {
  await collectHealthGauges(modelsWithRow(snapshotRow({ balancePiconeros: null, balanceUpdatedAt: null })))
  expect(await valueOf('monero_rewards_wallet_balance_piconeros')).toBe(0)
})

test('collectDBBackedMetrics sets pending tips from observedTip.count', async () => {
  const models = {
    observedTip: { count: jest.fn().mockResolvedValue(13) },
    $queryRaw: jest.fn().mockResolvedValue([{ failed: 2 }])
  }
  await collectDBBackedMetrics(models)
  expect(models.observedTip.count).toHaveBeenCalledWith({ where: { state: 'PENDING' } })
  expect(await valueOf('monero_pending_tips')).toBe(13)
})

test('collectDBBackedMetrics sets the pg-boss failed-jobs gauge from pgboss.job', async () => {
  const models = {
    observedTip: { count: jest.fn().mockResolvedValue(0) },
    $queryRaw: jest.fn().mockResolvedValue([{ failed: 5 }])
  }
  await collectDBBackedMetrics(models)
  expect(await valueOf('worker_pgjobs_failed_total')).toBe(5)
})

test('collectDBBackedMetrics maps the latest distribution status + opsPending piconeros', async () => {
  const models = {
    observedTip: { count: jest.fn().mockResolvedValue(0) },
    $queryRaw: jest.fn().mockResolvedValue([{ failed: 0 }]),
    rewardDistribution: {
      findFirst: jest.fn().mockResolvedValue({
        status: 'SENDING',
        opsAvailablePiconeros: 1000000000000n,
        opsSweptPiconeros: 600000000000n
      })
    }
  }
  await collectDBBackedMetrics(models)
  expect(await valueOf('monero_distribution_status')).toBe(1)
  expect(await valueOf('monero_ops_pending_piconeros')).toBe(400000000000)
})

test('collectDBBackedMetrics is a no-op without models and never throws on a null models arg', async () => {
  await expect(collectDBBackedMetrics(null)).resolves.toBeUndefined()
  await expect(collectDBBackedMetrics(undefined)).resolves.toBeUndefined()
})

test('collectDBBackedMetrics swallows DB errors and retains the previous gauge value', async () => {
  moneroPendingTips.set(99)
  const models = {
    observedTip: { count: jest.fn().mockRejectedValue(new Error('db down')) },
    $queryRaw: jest.fn().mockRejectedValue(new Error('db down')),
    rewardDistribution: { findFirst: jest.fn().mockRejectedValue(new Error('db down')) }
  }
  await expect(collectDBBackedMetrics(models)).resolves.toBeUndefined()
  expect(await valueOf('monero_pending_tips')).toBe(99)
})

test('rewards wallet balance gauge accepts a BigInt- coerced piconeros value', async () => {
  moneroRewardsWalletBalancePiconeros.set(Number(1234567890n))
  expect(await valueOf('monero_rewards_wallet_balance_piconeros')).toBe(1234567890)
})

async function valueOf (name) {
  const exposition = await register.metrics()
  const line = exposition.split('\n').find(l => {
    if (!l.startsWith(name)) return false
    const rest = l.slice(name.length)
    return rest.startsWith(' ') || rest.startsWith('{')
  })
  if (!line) throw new Error(`metric ${name} not found in exposition`)
  return Number(line.trim().split(/\s+/).pop())
}
