/* eslint-env jest */

// Unit tests for Query.rewards — the /rewards pool readout. Models are stubbed
// (mirrors test/api/resolvers/rewardsWallet.test.js) — no DB, no network.
//
// rewards.js transitively imports api/payIn (types barrel -> itemCreate ->
// lib/lexical/server/mentions) and api/resolvers/item (-> components/editor,
// lib/lexical/server/html), which pull ESM-only node_modules (mdast-util-from-
// markdown) that next/jest does not transform. Mirror the mocks in
// test/api/resolvers/statistics.test.js to break that chain — only
// Query.rewards is under test (donateToRewards and Reward.item stay stubbed).

jest.mock('../../../components/editor', () => ({
  __esModule: true,
  SNEditor: 'textarea'
}))

jest.mock('../../../api/payIn', () => ({
  __esModule: true,
  default: jest.fn()
}))

jest.mock('../../../lib/lexical/server/html', () => ({
  __esModule: true,
  lexicalHTMLGenerator: async () => ''
}))

const { Prisma } = require('@prisma/client')

// walletScope() (used by getNextRewardsPool for the ledger read) needs an
// explicit configured rewards-wallet identity.
process.env.PLATFORM_REWARDS_ADDRESS = '5HOTTESTWALLET'
process.env.MONERO_NETWORK = 'stagenet'

let resolvers

beforeEach(() => {
  // getActiveRewards caches its result for 10s in module state; a fresh module
  // registry per test keeps each active-path test off the previous one's cache.
  // jest.mock factories above survive jest.resetModules().
  jest.resetModules()
  resolvers = require('../../../api/resolvers/rewards').default
})

const DAY_MS = 24 * 60 * 60 * 1000

const CONFIG = {
  downvoteRewardsPct: 100,
  postingFeeRewardsPct: 70,
  territoryFeeRewardsPct: 30,
  boostRewardsPct: 30,
  walletlessTipRewardsPct: 70
}

function makeModels ({ inflow = {}, config = CONFIG, lastDistribution = null, ledger = {} } = {}) {
  const calls = jest.fn(async () => [{
    downvote: 1000000000n,
    posting: 1000000000n,
    territory: 200000000000n,
    donate: 0n,
    donateRaw: 0n,
    boost: 0n,
    walletlesstip: 0n,
    time: new Date('2026-08-07T00:00:00.000Z'),
    ...inflow
  }])
  const models = {
    platformFeeConfig: {
      findUnique: jest.fn(async () => config),
      upsert: jest.fn(async () => config)
    },
    rewardDistribution: {
      findFirst: jest.fn(async () => lastDistribution),
      // The ledger reader loads every recorded distribution (sweep facts).
      findMany: jest.fn(async () => ledger.distributions ?? [])
    },
    rewardPayout: { findMany: jest.fn(async () => ledger.payouts ?? []) },
    rewardsWalletTransaction: {
      findMany: jest.fn(async () => ledger.transactions ?? []),
      findUnique: jest.fn(async () => null)
    },
    rewardsWalletReconciliation: { findMany: jest.fn(async () => ledger.audits ?? []) },
    moneroAccount: {
      findFirst: jest.fn(async ({ where }) =>
        where?.label === 'platform_rewards'
          ? { id: 1, label: 'platform_rewards', address: process.env.PLATFORM_REWARDS_ADDRESS, network: 'STAGENET' }
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
    paymentTransactionProof: { findUnique: jest.fn(async () => null) },
    $queryRaw: calls
  }
  // The pool read runs inside one Serializable transaction; an omitted mock
  // must not silently exercise a weaker path.
  models.$transaction = jest.fn(async fn => fn(models))
  return models
}

describe('Query.rewards', () => {
  test('returns the rewards earmark (post-split) by source', async () => {
    const models = makeModels()
    const [reward] = await resolvers.Query.rewards(null, {}, { models })

    // downvote 1e9 * 100% + posting 1e9 * 70% + territory 2e11 * 30%
    expect(reward.total).toBe(1000000000n + 700000000n + 60000000000n)
    expect(reward.sources).toEqual([
      { name: 'downvote', value: '1000000000' },
      { name: 'posting fee', value: '700000000' },
      { name: 'turf fee', value: '60000000000' }
    ])
    expect(reward.time).toBeInstanceOf(Date)
  })

  test('active view adds the prior distribution rollover to the pool', async () => {
    // A distribution with a rolled-over pool (no eligible curators) must be
    // reflected in the pending pool — the next run's pool = this cycle's
    // earmark + rolledOverPiconeros (mirrors rewardsDistributor).
    const periodEnd = new Date(Date.now() - 2 * DAY_MS)
    const models = makeModels({
      lastDistribution: { periodEnd, rolledOverPiconeros: 6_800_000_000n }
    })
    const [reward] = await resolvers.Query.rewards(null, {}, { models })

    expect(reward.total).toBe(1000000000n + 700000000n + 60000000000n + 6_800_000_000n)
    expect(reward.sources).toContainEqual({ name: 'rolled over', value: '6800000000' })
  })

  test('active view pools inflow since the last distribution through the shared reader', async () => {
    const periodEnd = new Date(Date.now() - 2 * DAY_MS)
    const models = makeModels({ lastDistribution: { periodEnd } })
    await resolvers.Query.rewards(null, {}, { models })

    const [sql] = models.$queryRaw.mock.calls[0]
    expect(sql.join('?')).toContain('"confirmedAt" >= ?')
    // the eligible-receipt rule travels with the shared reader
    expect(sql.join('?')).toContain('"walletReceipt" = true')
    // the window start binds the last distribution's periodEnd, not now-WEEK_MS
    expect(models.$queryRaw.mock.calls[0][1]).toEqual(periodEnd)
    // one consistent Serializable read transaction wraps inflow + ledger
    expect(models.$transaction).toHaveBeenCalledTimes(1)
  })

  test('active view computes the next distribution slot in SQL, not a moving now-based time', async () => {
    const models = makeModels()
    await resolvers.Query.rewards(null, {}, { models })

    const [sql] = models.$queryRaw.mock.calls[0]
    // time = next Monday 00:00 UTC, computed in SQL (mirrors the Monday cron).
    // The resolver must NOT bind a JS-computed time value — the slot is fixed
    // in SQL so polling never sees a moving target.
    expect(sql.join('?')).toContain("date_trunc('week'")
    expect(sql.join('?')).toContain("interval '1 week'")
    // the query binds only the inflow window start (periodStart, 10×: downvote,
    // posting, territory, donate, donateRaw, boost, walletlesstip, bountyrollover,
    // bountyrolloverRewards, bountyfee) plus the 20 NULL end binds the open-cycle
    // reader passes — no JS-computed time value. 1 strings array + 30 values = 31
    // args (regression guard against re-introducing a bound now+7d time).
    expect(models.$queryRaw.mock.calls[0].length).toBe(31)
  })

  test('drops zero-earmark sources', async () => {
    // routed through the historical path (when) to exercise getRewards
    const models = makeModels({ inflow: { downvote: 0n, territory: 0n } })
    const [reward] = await resolvers.Query.rewards(null, { when: ['2026-08-05'] }, { models })

    expect(reward.total).toBe(700000000n)
    expect(reward.sources).toEqual([{ name: 'posting fee', value: '700000000' }])
  })

  test('the donations source (DONATE) funds the pool at 100%', async () => {
    // active path (getActiveRewards): a seeded DONATE observation flows in as
    // the "donations" inflow term, added to the pool at 100% (no allocation %
    // split).
    const models = makeModels({ inflow: { downvote: 0n, posting: 0n, territory: 0n, donate: 3_000_000_000n, boost: 0n, walletlesstip: 0n } })
    const [reward] = await resolvers.Query.rewards(null, {}, { models })

    expect(reward.sources).toEqual([{ name: 'donations', value: '3000000000' }])
    expect(reward.total).toBe(3_000_000_000n)
  })

  test('a donation with donationRewardsPct=50 funds the pool at 50%', async () => {
    const models = makeModels({ inflow: { downvote: 0n, posting: 0n, territory: 0n, donate: 1_500_000_000n, boost: 0n, walletlesstip: 0n } })
    const [reward] = await resolvers.Query.rewards(null, {}, { models })

    expect(reward.sources).toEqual([{ name: 'donations', value: '1500000000' }])
    expect(reward.total).toBe(1_500_000_000n)
  })

  test('the boosts source (BOOST) funds the pool at boostRewardsPct (30%), not 100%', async () => {
    // A seeded BOOST observation flows in as the "boosts" inflow term, added at
    // boostRewardsPct (30); the other 70% is the ops share.
    const models = makeModels({ inflow: { downvote: 0n, posting: 0n, territory: 0n, donate: 0n, boost: 4_000_000_000n, walletlesstip: 0n } })
    const [reward] = await resolvers.Query.rewards(null, {}, { models })

    expect(reward.sources).toEqual([{ name: 'boosts', value: '1200000000' }])
    expect(reward.total).toBe(1_200_000_000n) // 30% of 4e9
  })

  test('wallet-less tips (TIP_UNWALLETED) fund the pool at walletlessTipRewardsPct%', async () => {
    const models = makeModels({ inflow: { downvote: 0n, posting: 0n, territory: 0n, donate: 0n, boost: 0n, walletlesstip: 2_000_000_000n } })
    const [reward] = await resolvers.Query.rewards(null, {}, { models })

    expect(reward.sources).toEqual([{ name: 'wallet-less tips', value: '1400000000' }])
    expect(reward.total).toBe(1_400_000_000n) // 70% of 2e9
  })

  test('historical rewards resolve to the covering weekly distribution', async () => {
    const periodStart = new Date('2026-07-25T00:00:00.000Z')
    const periodEnd = new Date('2026-08-01T00:00:00.000Z')
    const models = makeModels({
      lastDistribution: { periodStart, periodEnd, distributedPiconeros: 3_200_000_000_000n }
    })
    const [reward] = await resolvers.Query.rewards(null, { when: ['2026-07-28'] }, { models })

    expect(reward.total).toBe(3_200_000_000_000n)
    expect(reward.time.toISOString()).toBe('2026-07-28T00:00:00.000Z') // requested date, not periodEnd
    expect(reward.periodStart).toBe(periodStart)
    expect(reward.periodEnd).toBe(periodEnd)
    // the source pie is read through the shared reader over the SAME covering
    // window the distributor used (half-open [start, end) on every subselect)
    const [sql, ...values] = models.$queryRaw.mock.calls[0]
    expect(sql.join('?')).toContain('"walletReceipt" = true')
    expect(values.filter(v => v === periodStart)).toHaveLength(10)
    expect(values.filter(v => v === periodEnd)).toHaveLength(20)
  })

  test('historical rewards keep the rollover\'s exact mixed reward component through the shared reader', async () => {
    // A rollover row stores the full net receipt (139) in piconeros and its
    // exact reward component (100) in rewardsPiconeros; the ops remainder must
    // not leak into the historical pool.
    const models = makeModels({
      inflow: { downvote: 0n, posting: 0n, territory: 0n, bountyrollover: 139n, bountyrolloverRewards: 100n }
    })
    const [reward] = await resolvers.Query.rewards(null, { when: ['2026-08-05'] }, { models })

    expect(reward.total).toBe(100n)
    expect(reward.sources).toEqual([{ name: 'bounty rollovers', value: '100' }])
  })

  test('historical rewards fall back to day inflow before the first distribution', async () => {
    const models = makeModels() // lastDistribution: null
    const [reward] = await resolvers.Query.rewards(null, { when: ['2026-08-05'] }, { models })

    expect(reward.periodStart).toBeUndefined()
    expect(reward.periodEnd).toBeUndefined()
    expect(reward.total).toBe(1000000000n + 700000000n + 60000000000n) // stub earmark
    // pre-first-distribution fallback = the requested UTC day, read through the
    // same shared reader (no separate SQL path can drift)
    const d = new Date('2026-08-05').getTime()
    const [, ...values] = models.$queryRaw.mock.calls[0]
    expect(values.filter(v => v instanceof Date && v.getTime() === d)).toHaveLength(10)
    expect(values.filter(v => v instanceof Date && v.getTime() === d + DAY_MS)).toHaveLength(20)
  })

  test('rejects too many dates and invalid dates', async () => {
    const models = makeModels()
    await expect(resolvers.Query.rewards(null, { when: ['2026-08-05', '2026-08-06'] }, { models }))
      .rejects.toThrow(/too many dates/i)
    await expect(resolvers.Query.rewards(null, { when: ['garbage'] }, { models }))
      .rejects.toThrow(/invalid date/i)
  })

  test('donateToRewards passes rewardsPct through to the pay engine', async () => {
    const pay = require('../../../api/payIn').default
    pay.mockClear()
    pay.mockResolvedValue({ id: 42 })
    const resolvers = require('../../../api/resolvers/rewards').default
    const result = await resolvers.Mutation.donateToRewards(null, { piconeros: 3_000_000_000n, rewardsPct: 50 }, { me: { id: 1 }, models: {} })
    expect(result).toEqual({ id: 42 })
    expect(pay).toHaveBeenCalledWith('DONATE', { piconeros: 3_000_000_000n, rewardsPct: 50 }, expect.anything())
  })

  test('donateToRewards rejects rewardsPct outside 0-100', async () => {
    const resolvers = require('../../../api/resolvers/rewards').default
    await expect(resolvers.Mutation.donateToRewards(null, { piconeros: 3_000_000_000n, rewardsPct: 101 }, { me: { id: 1 }, models: {} }))
      .rejects.toThrow(/rewardsPct/)
    await expect(resolvers.Mutation.donateToRewards(null, { piconeros: 3_000_000_000n, rewardsPct: -1 }, { me: { id: 1 }, models: {} }))
      .rejects.toThrow(/rewardsPct/)
  })
})

describe('Query.meRewards', () => {
  test('returns the covering distribution Earn rows for the viewer', async () => {
    const periodStart = new Date('2026-07-25T00:00:00.000Z')
    const periodEnd = new Date('2026-08-01T00:00:00.000Z')
    const covering = { id: 42, periodStart, periodEnd }
    const models = {
      rewardDistribution: { findFirst: jest.fn(async () => covering) },
      $queryRaw: jest.fn(async () => [{
        // Prisma $queryRaw deserializes PostgreSQL numeric (sum(int8)) as a
        // Decimal object, NOT a bigint — the shape that crashed the BigInt
        // scalar serializer during SSR. The resolver must coerce it.
        total: new Prisma.Decimal('1200000000'),
        rewards: [{ type: 'TIP_POST', rank: 3, piconeros: '1200000000', typeId: null }]
      }])
    }
    const [mine] = await resolvers.Query.meRewards(null, { when: ['2026-07-28'] }, { me: { id: 7 }, models })

    expect(mine.total).toBe(1_200_000_000n)
    expect(mine.rewards[0]).toMatchObject({ type: 'TIP_POST', rank: 3 })
    expect(mine.rewards[0].piconeros).toBe('1200000000')
    // the Earn query is scoped to the covering distribution id (the last bound arg)
    const [, ...args] = models.$queryRaw.mock.calls[0]
    expect(args[args.length - 1]).toBe(42)
    // the per-reward piconeros must be cast to text in the json_build_object so
    // Prisma returns an exact string, not a lossy JS number (precision > 2^53)
    const [sql] = models.$queryRaw.mock.calls[0]
    expect(sql.join('?')).toContain('piconeros::text')
  })

  test('returns empty when no covering distribution exists', async () => {
    const models = { rewardDistribution: { findFirst: jest.fn(async () => null) } }
    const result = await resolvers.Query.meRewards(null, { when: ['2026-06-01'] }, { me: { id: 7 }, models })
    expect(result).toEqual([])
  })

  test('coerces the raw Decimal total to an exact BigInt (regression: serializer threw on Prisma Decimal)', async () => {
    const periodStart = new Date('2026-07-25T00:00:00.000Z')
    const periodEnd = new Date('2026-08-01T00:00:00.000Z')
    const models = {
      rewardDistribution: { findFirst: jest.fn(async () => ({ id: 42, periodStart, periodEnd })) },
      $queryRaw: jest.fn(async () => [{
        // > 2^53: a JS number would lose precision; the Decimal string must
        // survive the BigInt() coercion exactly.
        total: new Prisma.Decimal('12345678901234567890'),
        rewards: []
      }])
    }
    const [mine] = await resolvers.Query.meRewards(null, { when: ['2026-07-28'] }, { me: { id: 7 }, models })

    expect(typeof mine.total).toBe('bigint')
    expect(mine.total).toBe(12345678901234567890n)
  })

  test('returns empty when the covering distribution has no Earn rows for the viewer', async () => {
    const periodStart = new Date('2026-07-25T00:00:00.000Z')
    const periodEnd = new Date('2026-08-01T00:00:00.000Z')
    const models = {
      rewardDistribution: { findFirst: jest.fn(async () => ({ id: 42, periodStart, periodEnd })) },
      $queryRaw: jest.fn(async () => [])
    }
    const result = await resolvers.Query.meRewards(null, { when: ['2026-07-28'] }, { me: { id: 7 }, models })
    expect(result).toEqual([])
  })
})
