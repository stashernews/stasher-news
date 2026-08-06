/* eslint-env jest */

// Unit tests for Query.rewards — the /rewards pool readout. Models are stubbed
// (mirrors test/api/resolvers/rewardsWallet.test.js) — no DB, no network.
//
import resolvers from '@/api/resolvers/rewards'

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

const CONFIG = {
  downvoteRewardsPct: 100,
  postingFeeRewardsPct: 70,
  territoryFeeRewardsPct: 30
}

function makeModels (inflow = {}, config = CONFIG) {
  const calls = jest.fn(async () => [{
    downvote: 1000000000n,
    posting: 1000000000n,
    territory: 200000000000n,
    time: new Date('2026-08-07T05:00:00.000Z'),
    ...inflow
  }])
  return {
    platformFeeConfig: { upsert: jest.fn(async () => config) },
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

  test('drops zero-earmark sources', async () => {
    // routed through the historical path (when) because the active path serves
    // the module-level rewardCache for 10s and would leak the prior test's data
    const models = makeModels({ downvote: 0n, territory: 0n })
    const [reward] = await resolvers.Query.rewards(null, { when: ['2026-08-05'] }, { models })

    expect(reward.total).toBe(700000000n)
    expect(reward.sources).toEqual([{ name: 'posting fee', value: '700000000' }])
  })

  test('historical rewards use the requested day', async () => {
    const models = makeModels({ downvote: 500000000n, posting: 0n, territory: 0n })
    const [reward] = await resolvers.Query.rewards(null, { when: ['2026-08-05'] }, { models })

    expect(reward.total).toBe(500000000n)
    expect(reward.sources).toEqual([{ name: 'downvote', value: '500000000' }])
  })

  test('rejects too many dates and invalid dates', async () => {
    const models = makeModels()
    await expect(resolvers.Query.rewards(null, { when: ['2026-08-05', '2026-08-06'] }, { models }))
      .rejects.toThrow(/too many dates/i)
    await expect(resolvers.Query.rewards(null, { when: ['garbage'] }, { models }))
      .rejects.toThrow(/invalid date/i)
  })
})
