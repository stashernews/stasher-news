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
  default: {}
}))

jest.mock('../../../lib/lexical/server/html', () => ({
  __esModule: true,
  lexicalHTMLGenerator: async () => ''
}))

let resolvers

beforeEach(() => {
  // getActiveRewards caches its result for 10s in module state; a fresh module
  // registry per test keeps each active-path test off the previous one's cache.
  // jest.mock factories above survive jest.resetModules().
  jest.resetModules()
  resolvers = require('../../../api/resolvers/rewards').default
})

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

const CONFIG = {
  downvoteRewardsPct: 100,
  postingFeeRewardsPct: 70,
  territoryFeeRewardsPct: 30
}

function makeModels ({ inflow = {}, config = CONFIG, lastDistribution = null } = {}) {
  const calls = jest.fn(async () => [{
    downvote: 1000000000n,
    posting: 1000000000n,
    territory: 200000000000n,
    time: new Date('2026-08-07T00:00:00.000Z'),
    ...inflow
  }])
  return {
    platformFeeConfig: { upsert: jest.fn(async () => config) },
    rewardDistribution: { findFirst: jest.fn(async () => lastDistribution) },
    $queryRaw: calls
  }
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

  test('active view counts down to the next weekly distribution', async () => {
    const periodEnd = new Date(Date.now() - 2 * DAY_MS)
    const models = makeModels({ lastDistribution: { periodEnd } })
    const [reward] = await resolvers.Query.rewards(null, {}, { models })

    // next distribution = last periodEnd + 7d (worker self-requeues WEEK_SECONDS later)
    expect(reward.time.getTime()).toBe(periodEnd.getTime() + WEEK_MS)
  })

  test('active view pools inflow since the last distribution, with no day truncation', async () => {
    const periodEnd = new Date(Date.now() - 2 * DAY_MS)
    const models = makeModels({ lastDistribution: { periodEnd } })
    await resolvers.Query.rewards(null, {}, { models })

    const [sql] = models.$queryRaw.mock.calls[0]
    expect(sql.join('?')).toContain('"confirmedAt" >= ?')
    expect(sql.join('?')).not.toContain('date_trunc')

    // the window start binds the last distribution's periodEnd, not now-WEEK_MS
    expect(models.$queryRaw.mock.calls[0][1]).toEqual(periodEnd)
  })

  test('active view falls back to now+7d when no distribution has run yet', async () => {
    const models = makeModels()
    const before = Date.now()
    const [reward] = await resolvers.Query.rewards(null, {}, { models })
    const after = Date.now()

    expect(reward.time.getTime()).toBeGreaterThanOrEqual(before + WEEK_MS)
    expect(reward.time.getTime()).toBeLessThanOrEqual(after + WEEK_MS)
  })

  test('drops zero-earmark sources', async () => {
    // routed through the historical path (when) to exercise getRewards
    const models = makeModels({ inflow: { downvote: 0n, territory: 0n } })
    const [reward] = await resolvers.Query.rewards(null, { when: ['2026-08-05'] }, { models })

    expect(reward.total).toBe(700000000n)
    expect(reward.sources).toEqual([{ name: 'posting fee', value: '700000000' }])
  })

  test('the extra source (DONATE/TIP_UNWALLETED/BOOST) funds the pool at 100%', async () => {
    // active path (getActiveRewards): a seeded DONATE observation flows in as the
    // "extra" inflow term, added to the pool at 100% (no allocation % split).
    const models = makeModels({ inflow: { downvote: 0n, posting: 0n, territory: 0n, extra: 3_000_000_000n } })
    const [reward] = await resolvers.Query.rewards(null, {}, { models })

    expect(reward.sources).toEqual([{ name: 'extra', value: '3000000000' }])
    expect(reward.total).toBe(3_000_000_000n)
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
  })

  test('historical rewards fall back to day inflow before the first distribution', async () => {
    const models = makeModels() // lastDistribution: null
    const [reward] = await resolvers.Query.rewards(null, { when: ['2026-08-05'] }, { models })

    expect(reward.periodStart).toBeUndefined()
    expect(reward.periodEnd).toBeUndefined()
    expect(reward.total).toBe(1000000000n + 700000000n + 60000000000n) // stub earmark
  })

  test('rejects too many dates and invalid dates', async () => {
    const models = makeModels()
    await expect(resolvers.Query.rewards(null, { when: ['2026-08-05', '2026-08-06'] }, { models }))
      .rejects.toThrow(/too many dates/i)
    await expect(resolvers.Query.rewards(null, { when: ['garbage'] }, { models }))
      .rejects.toThrow(/invalid date/i)
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
        total: 1_200_000_000n,
        rewards: [{ type: 'TIP_POST', rank: 3, piconeros: 1_200_000_000n, typeId: null }]
      }])
    }
    const [mine] = await resolvers.Query.meRewards(null, { when: ['2026-07-28'] }, { me: { id: 7 }, models })

    expect(mine.total).toBe(1_200_000_000n)
    expect(mine.rewards[0]).toMatchObject({ type: 'TIP_POST', rank: 3 })
    // the Earn query is scoped to the covering distribution id (the last bound arg)
    const [, ...args] = models.$queryRaw.mock.calls[0]
    expect(args[args.length - 1]).toBe(42)
  })

  test('returns empty when no covering distribution exists', async () => {
    const models = { rewardDistribution: { findFirst: jest.fn(async () => null) } }
    const result = await resolvers.Query.meRewards(null, { when: ['2026-06-01'] }, { me: { id: 7 }, models })
    expect(result).toEqual([])
  })
})
