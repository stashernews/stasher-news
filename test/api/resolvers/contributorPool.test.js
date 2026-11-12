/* eslint-env jest */
import rewardsResolvers, { nextMondayUtc, resetContributorPoolCache } from '@/api/resolvers/rewards'
import { computeContributorShares } from '@/worker/contributorShares'

jest.mock('../../../components/editor', () => ({ __esModule: true, SNEditor: 'textarea' }))
jest.mock('../../../api/payIn', () => ({ __esModule: true, default: {} }))
jest.mock('../../../lib/lexical/server/html', () => ({ __esModule: true, lexicalHTMLGenerator: async () => '' }))
jest.mock('../../../worker/contributorShares', () => ({ computeContributorShares: jest.fn() }))
jest.mock('../../../lib/logger', () => ({ __esModule: true, default: { info: jest.fn() }, logInfo: jest.fn(), logWarn: jest.fn(), logError: jest.fn() }))

const { Query: { contributorPool: contributorPoolQuery }, ContributorPool: poolFields } = rewardsResolvers

// The full public view: the cheap root plus the lazily resolved fields.
async function contributorPool (parent, args, ctx) {
  const root = await contributorPoolQuery(parent, args, ctx)
  return {
    mode: root.mode,
    lastRun: await poolFields.lastRun(root, args, ctx),
    candidates: await poolFields.candidates(root, args, ctx)
  }
}

const CONFIG = {
  contributorPoolMode: 'SHADOW',
  contributorShareBps: 1500,
  contributorTopN: 5,
  contributorWinnerCapBps: 4000,
  contributorCombinedCapBps: 0,
  contributorMinTipPiconeros: 500000000n,
  contributorTrustThreshold: 0.1,
  contributorMinTrustedTippers: 3,
  contributorTipperCapBps: 3334,
  contributorBreadthTarget: 5,
  contributorReciprocityMult: 0.5,
  contributorReciprocityDays: 30,
  contributorCommentBonusBps: 500,
  contributorCommentBonusMax: 8,
  contributorMinAccountAgeDays: 14,
  contributorLengthFloor: 0.6,
  contributorLengthScaleWords: 100,
  contributorLengthCapWords: 1500,
  distributionExcludedCuratorIds: []
}

const RUN = {
  periodEnd: new Date('2026-10-19T00:00:00Z'),
  contributorPoolMode: 'SHADOW',
  contributorBudgetPiconeros: 0n,
  contributorParams: {
    scored: [
      { itemId: 12, authorId: 7, rank: 2, share: '3000000000', S: 31.3, n: 6, base: 10, trims: [] },
      { itemId: 11, authorId: 8, rank: 1, share: '9000000000', S: 40.1, n: 5, base: 12, trims: [] },
      { itemId: 13, authorId: 9, rank: null, share: null, S: 2, n: 1, base: 1, trims: [] }
    ]
  }
}

const mkModels = (config, run = RUN) => ({
  platformFeeConfig: { findUnique: jest.fn(async () => config) },
  rewardDistribution: { findFirst: jest.fn(async () => run) }
})

beforeEach(() => {
  resetContributorPoolCache()
  computeContributorShares.mockReset()
})

test('the root query reads only the config row; winners and candidates are lazy', async () => {
  const models = mkModels(CONFIG)
  await expect(contributorPoolQuery(null, {}, { models })).resolves.toEqual({ mode: 'SHADOW' })
  expect(computeContributorShares).not.toHaveBeenCalled()
  expect(models.rewardDistribution.findFirst).not.toHaveBeenCalled()
})

test('OFF returns an empty pool and never touches the candidate SQL', async () => {
  const models = mkModels({ ...CONFIG, contributorPoolMode: 'OFF' })
  await expect(contributorPool(null, {}, { models })).resolves.toEqual({ mode: 'OFF', lastRun: null, candidates: [] })
  expect(computeContributorShares).not.toHaveBeenCalled()
  expect(models.rewardDistribution.findFirst).not.toHaveBeenCalled()
})

test('an invalid config reads as OFF', async () => {
  const models = mkModels({ ...CONFIG, contributorShareBps: 0 })
  expect((await contributorPool(null, {}, { models })).mode).toBe('OFF')
})

const CURATOR_ACTIVE = {
  curatorBudgetMode: 'ACTIVE',
  curatorBudgetMultBps: 15000,
  curatorBudgetDrawdownWeeks: 13,
  curatorBudgetAvgPeriods: 4,
  curatorTipCapShareBps: 2500,
  curatorBreakerRatioBps: 25000,
  curatorBreakerFloorMedianPeriods: 12,
  curatorBreakerArmPeriods: 4
}

test('ACTIVE shows as ACTIVE only while the curator budget is ACTIVE', async () => {
  computeContributorShares.mockResolvedValue({ winners: [] })
  const active = mkModels({ ...CONFIG, ...CURATOR_ACTIVE, contributorPoolMode: 'ACTIVE' })
  expect((await contributorPoolQuery(null, {}, { models: active })).mode).toBe('ACTIVE')
  for (const curatorBudgetMode of ['LEGACY', 'SHADOW']) {
    const models = mkModels({ ...CONFIG, ...CURATOR_ACTIVE, curatorBudgetMode, contributorPoolMode: 'ACTIVE' })
    expect((await contributorPoolQuery(null, {}, { models })).mode).toBe('SHADOW')
  }
  // invalid curator config fails closed to LEGACY, so contributors only shadow
  const bad = mkModels({ ...CONFIG, ...CURATOR_ACTIVE, curatorBudgetMultBps: 1, contributorPoolMode: 'ACTIVE' })
  expect((await contributorPoolQuery(null, {}, { models: bad })).mode).toBe('SHADOW')
})

test('SHADOW exposes ranks, amounts and item ids only — never scores', async () => {
  computeContributorShares.mockResolvedValue({ winners: [{ itemId: 21, S: 99, weight: 4, trustedTippers: 7 }, { itemId: 22, S: 50 }] })
  const pool = await contributorPool(null, {}, { models: mkModels(CONFIG) })

  expect(pool.mode).toBe('SHADOW')
  expect(pool.candidates).toEqual([{ rank: 1, itemId: 21 }, { rank: 2, itemId: 22 }])
  expect(pool.lastRun.mode).toBe('SHADOW')
  expect(pool.lastRun.results).toEqual([
    { rank: 1, piconeros: 9000000000n, itemId: 11 },
    { rank: 2, piconeros: 3000000000n, itemId: 12 }
  ])
  const wire = JSON.stringify(pool, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  for (const leaked of ['"S"', 'weight', 'trusted', 'authorId', 'base', 'trims']) expect(wire).not.toContain(leaked)
})

test('uses the upcoming Monday as the run week and the exclusion list', async () => {
  computeContributorShares.mockResolvedValue({ winners: [] })
  await contributorPool(null, {}, { models: mkModels({ ...CONFIG, distributionExcludedCuratorIds: [999] }) })
  const args = computeContributorShares.mock.calls[0][1]
  expect(args.weekStart.getUTCDay()).toBe(1)
  expect(args.weekStart.getTime()).toBeGreaterThan(Date.now())
  expect(args.excludedIds).toContain(999)
})

test('candidate failures degrade to an empty list', async () => {
  computeContributorShares.mockRejectedValueOnce(new Error('boom'))
  const models = mkModels(CONFIG)
  expect((await contributorPool(null, {}, { models })).candidates).toEqual([])
})

test('the result is cached for the TTL', async () => {
  computeContributorShares.mockResolvedValue({ winners: [] })
  const models = mkModels(CONFIG)
  await contributorPool(null, {}, { models })
  await contributorPool(null, {}, { models })
  expect(computeContributorShares).toHaveBeenCalledTimes(1)
})

test('lastRun and candidates resolved together share one refresh', async () => {
  let release
  computeContributorShares.mockImplementation(() => new Promise(resolve => { release = () => resolve({ winners: [] }) }))
  const models = mkModels(CONFIG)
  const root = await contributorPoolQuery(null, {}, { models })
  const both = Promise.all([poolFields.lastRun(root, {}, { models }), poolFields.candidates(root, {}, { models })])
  await new Promise(resolve => setImmediate(resolve))
  release()
  await both
  expect(computeContributorShares).toHaveBeenCalledTimes(1)
})

test('nextMondayUtc is the following Monday 00:00 UTC', () => {
  expect(nextMondayUtc(new Date('2026-10-30T11:00:00Z')).toISOString()).toBe('2026-11-02T00:00:00.000Z')
  expect(nextMondayUtc(new Date('2026-11-02T00:00:00Z')).toISOString()).toBe('2026-11-09T00:00:00.000Z')
  expect(nextMondayUtc(new Date('2026-11-01T23:59:00Z')).toISOString()).toBe('2026-11-02T00:00:00.000Z')
})
