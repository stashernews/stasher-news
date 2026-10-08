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
  moneroRewardsNetworkFeesPiconeros,
  moneroOpsDeficitPiconeros,
  moneroRewardsAccountingUncertain,
  workerPgjobsFailedTotal,
  moneroDetectionLevelTotal,
  moneroTxNotFoundExclusionsTotal
} from '@/lib/metrics'

// getNextRewardsPool (invoked by collectDBBackedMetrics) reads the ledger via
// walletScope(), which needs a configured rewards-wallet identity.
process.env.PLATFORM_REWARDS_ADDRESS = '5METRICSHOT'
process.env.MONERO_NETWORK = 'stagenet'

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
  'monero_rewards_network_fees_piconeros',
  'monero_ops_deficit_piconeros',
  'monero_rewards_accounting_uncertain',
  'worker_pgjobs_failed_total',
  'monero_detection_level_total',
  'monero_tx_not_found_exclusions_total'
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
    moneroOpsPendingPiconeros, moneroRewardsNetworkFeesPiconeros,
    moneroOpsDeficitPiconeros, moneroRewardsAccountingUncertain,
    workerPgjobsFailedTotal,
    moneroDetectionLevelTotal, moneroTxNotFoundExclusionsTotal
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

test('detection-level counter accumulates per level label and the exclusion counter accumulates', async () => {
  moneroDetectionLevelTotal.inc({ level: 'lws' })
  moneroDetectionLevelTotal.inc({ level: 'daemon' })
  moneroDetectionLevelTotal.inc({ level: 'daemon' })
  moneroTxNotFoundExclusionsTotal.inc()
  const levels = Object.fromEntries(
    (await moneroDetectionLevelTotal.get()).values.map(v => [v.labels.level, v.value])
  )
  expect(levels).toEqual({ lws: 1, daemon: 2 })
  expect((await moneroTxNotFoundExclusionsTotal.get()).values[0].value).toBe(1)
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

test('collectDBBackedMetrics maps the latest distribution status + opsPending piconeros aligned with the pool definition', async () => {
  // The gauge mirrors lib/rewardsPool.js pendingSweepPiconeros: unswept carry
  // (1e12 - 6e11 = 4e11) + the open cycle's ops earmark (posting 1e12 at 70%
  // rewards -> 3e11). The old definition stopped at the 4e11 carry, while the
  // transparency page (correctly) showed 7e11.
  const models = {
    observedTip: { count: jest.fn().mockResolvedValue(0) },
    $queryRaw: jest.fn(async (strings) => {
      const sql = Array.isArray(strings) ? strings.join(' ') : String(strings)
      if (sql.includes('pgboss')) return [{ failed: 0 }]
      return [{
        downvote: 0n,
        posting: 1_000_000_000_000n,
        territory: 0n,
        donate: 0n,
        donateRaw: 0n,
        boost: 0n,
        walletlesstip: 0n,
        bountyrollover: 0n,
        bountyrolloverRewards: 0n,
        bountyfee: 0n,
        time: new Date('2026-09-21T00:00:00.000Z')
      }]
    }),
    platformFeeConfig: {
      upsert: jest.fn().mockResolvedValue(METRICS_CONFIG),
      findUnique: jest.fn().mockResolvedValue(METRICS_CONFIG)
    },
    rewardDistribution: {
      findFirst: jest.fn().mockResolvedValue({
        id: 1,
        status: 'SENDING',
        periodEnd: new Date('2026-09-14T00:00:00.000Z'),
        opsAvailablePiconeros: 1_000_000_000_000n,
        opsSweptPiconeros: 600_000_000_000n
      }),
      findMany: jest.fn().mockResolvedValue([{
        id: 1,
        status: 'SENDING',
        periodStart: null,
        periodEnd: new Date('2026-09-14T00:00:00.000Z'),
        poolPiconeros: 0n,
        distributedPiconeros: 0n,
        rolledOverPiconeros: 0n,
        payoutCount: 0,
        opsInflowPiconeros: 0n,
        opsRolledOverPiconeros: 0n,
        opsAvailablePiconeros: 1_000_000_000_000n,
        opsSweptPiconeros: 600_000_000_000n,
        opsSweepState: null,
        opsSweepTxHash: null,
        opsNetworkFeesAccountedPiconeros: 0n
      }])
    },
    rewardPayout: { findMany: jest.fn().mockResolvedValue([]) },
    rewardsWalletTransaction: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null)
    },
    rewardsWalletReconciliation: { findMany: jest.fn().mockResolvedValue([]) },
    moneroAccount: {
      findFirst: jest.fn(async ({ where }) =>
        where?.label === 'platform_rewards'
          ? { id: 1, label: 'platform_rewards', address: '5METRICSHOT', network: 'STAGENET' }
          : null)
    },
    // Audit-snapshot side groups (empty; no bounty/escrow facts in this DB).
    subaddressIndex: { findMany: jest.fn(async () => []) },
    feeObservation: { findMany: jest.fn(async () => []) },
    observedDownvote: { findMany: jest.fn(async () => []) },
    escrowWalletTransaction: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
    bountyPayment: { findMany: jest.fn(async () => []) },
    observedBounty: { findMany: jest.fn(async () => []) },
    observedBountyReceipt: { findMany: jest.fn(async () => []) },
    item: { findMany: jest.fn(async () => []) },
    earn: { findMany: jest.fn(async () => []) },
    paymentTransactionProof: { findUnique: jest.fn(async () => null) }
  }
  models.$transaction = async fn => fn(models)
  await collectDBBackedMetrics(models)
  expect(await valueOf('monero_distribution_status')).toBe(1)
  expect(await valueOf('monero_ops_pending_piconeros')).toBe(700_000_000_000)
})

// A RELAYED consolidation is a pure hot-wallet fee fact (principal zero).
// Journal rows carry the audit snapshot's FULL closed column shape.
function feeFact (fee, txHash) {
  return {
    id: null,
    network: 'STAGENET',
    walletAddress: '5METRICSHOT',
    txHash,
    kind: 'CONSOLIDATION',
    accountIndex: 0,
    state: 'RELAYED',
    distributionId: null,
    principalPiconeros: 0n,
    networkFeePiconeros: fee,
    metadata: { destination: '5METRICSHOT', selfTransfer: true },
    preparedAt: null,
    relayAttemptedAt: null,
    relayedAt: null,
    relayProvenance: null,
    dispatchId: null,
    captureContractVersion: null,
    claimDigest: null,
    paymentClaims: null,
    proofId: null
  }
}

const METRICS_CONFIG = {
  downvoteRewardsPct: 100,
  postingFeeRewardsPct: 70,
  territoryFeeRewardsPct: 30,
  walletlessTipRewardsPct: 70,
  boostRewardsPct: 30
}

// Models for the rewards-pool accounting gauges: recorded distributions, a
// cycle inflow and the ledger facts. $queryRaw answers both the pgboss
// failed-jobs query and the shared inflow reader.
function accountingModels ({ allTime = {}, distributions = [], transactions = [] } = {}) {
  const row = {
    downvote: 0n,
    posting: 0n,
    territory: 0n,
    donate: 0n,
    donateRaw: 0n,
    boost: 0n,
    walletlesstip: 0n,
    bountyrollover: 0n,
    bountyrolloverRewards: 0n,
    bountyfee: 0n,
    time: new Date('2026-09-21T00:00:00.000Z'),
    ...allTime
  }
  const models = {
    observedTip: { count: jest.fn().mockResolvedValue(0) },
    $queryRaw: jest.fn(async (strings) => {
      const sql = Array.isArray(strings) ? strings.join(' ') : String(strings)
      if (sql.includes('pgboss')) return [{ failed: 0 }]
      return [row]
    }),
    platformFeeConfig: {
      upsert: jest.fn().mockResolvedValue(METRICS_CONFIG),
      findUnique: jest.fn().mockResolvedValue(METRICS_CONFIG)
    },
    rewardDistribution: {
      findFirst: jest.fn().mockResolvedValue(distributions[distributions.length - 1] ?? null),
      // Full closed distribution shape: the audit snapshot projects every
      // expected column; tests only vary the accounting facts.
      findMany: jest.fn().mockResolvedValue(distributions.map(d => ({
        periodStart: null,
        poolPiconeros: 0n,
        distributedPiconeros: 0n,
        payoutCount: 0,
        opsInflowPiconeros: 0n,
        opsRolledOverPiconeros: 0n,
        opsSweepState: null,
        ...d
      })))
    },
    rewardPayout: { findMany: jest.fn().mockResolvedValue([]) },
    rewardsWalletTransaction: {
      findMany: jest.fn().mockResolvedValue(transactions),
      findUnique: jest.fn().mockResolvedValue(null)
    },
    rewardsWalletReconciliation: { findMany: jest.fn().mockResolvedValue([]) },
    moneroAccount: {
      findFirst: jest.fn(async ({ where }) =>
        where?.label === 'platform_rewards'
          ? { id: 1, label: 'platform_rewards', address: '5METRICSHOT', network: 'STAGENET' }
          : null)
    },
    // Audit-snapshot side groups (empty; no bounty/escrow facts in this DB).
    subaddressIndex: { findMany: jest.fn(async () => []) },
    feeObservation: { findMany: jest.fn(async () => []) },
    observedDownvote: { findMany: jest.fn(async () => []) },
    escrowWalletTransaction: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
    bountyPayment: { findMany: jest.fn(async () => []) },
    observedBounty: { findMany: jest.fn(async () => []) },
    observedBountyReceipt: { findMany: jest.fn(async () => []) },
    item: { findMany: jest.fn(async () => []) },
    earn: { findMany: jest.fn(async () => []) },
    paymentTransactionProof: { findUnique: jest.fn(async () => null) }
  }
  models.$transaction = async fn => fn(models)
  return models
}

test('collectDBBackedMetrics exposes signed pending ops, the ops deficit, cumulative fees and uncertainty', async () => {
  const models = accountingModels({
    allTime: { downvote: 96n, bountyfee: 4n },
    distributions: [{
      id: 1,
      status: 'COMPLETE',
      periodEnd: new Date('2026-09-14T00:00:00.000Z'),
      rolledOverPiconeros: 0n,
      opsAvailablePiconeros: 10n,
      opsSweptPiconeros: 10n,
      opsSweepTxHash: null,
      opsNetworkFeesAccountedPiconeros: 0n
    }],
    transactions: [feeFact(7n, 'dd'.repeat(32))]
  })

  await collectDBBackedMetrics(models)

  expect(await valueOf('monero_ops_pending_piconeros')).toBe(-3) // -7 fee-adjusted carry + 4 open ops
  expect(await valueOf('monero_ops_deficit_piconeros')).toBe(3)
  expect(await valueOf('monero_rewards_network_fees_piconeros')).toBe(7)
  expect(await valueOf('monero_rewards_accounting_uncertain')).toBe(0)
  expect(await valueOf('monero_distribution_status')).toBe(2)
})

test('an accounting-read failure pins uncertainty at 1 and a later clean read restores 0', async () => {
  const failing = {
    observedTip: { count: jest.fn().mockResolvedValue(0) },
    $queryRaw: jest.fn().mockRejectedValue(new Error('db down')),
    rewardDistribution: { findFirst: jest.fn().mockRejectedValue(new Error('db down')) }
  }
  await expect(collectDBBackedMetrics(failing)).resolves.toBeUndefined()
  expect(await valueOf('monero_rewards_accounting_uncertain')).toBe(1)

  await collectDBBackedMetrics(accountingModels())
  expect(await valueOf('monero_rewards_accounting_uncertain')).toBe(0)
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
