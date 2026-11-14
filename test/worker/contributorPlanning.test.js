/* eslint-env jest */
import { runDistributionOnce } from '@/worker/rewardsDistributor'
import { selectContributorWinners, decideContributorMode } from '@/worker/contributorPoolRun'
import { planCuratorBudget } from '@/worker/curatorBudget'
import { CONFIG, NOW, budgetPlan, planningModels } from '../helpers/contributorPlanning'

jest.mock('../../components/editor', () => ({ __esModule: true, SNEditor: 'textarea' }))
jest.mock('../../api/payIn', () => ({ __esModule: true, default: {} }))
jest.mock('../../lib/lexical/server/html', () => ({ __esModule: true, lexicalHTMLGenerator: async () => '' }))
jest.mock('../../lib/logger', () => ({ __esModule: true, default: { info: jest.fn() }, logInfo: jest.fn(), logWarn: jest.fn(), logError: jest.fn() }))
jest.mock('../../lib/alert', () => ({ alert: jest.fn() }))
jest.mock('../../api/monero/rewards', () => ({ sendPayouts: () => { throw new Error('no wallet allowed') } }))
jest.mock('../../worker/curatorBudget', () => ({
  ...jest.requireActual('../../worker/curatorBudget'),
  planCuratorBudget: jest.fn(),
  readTrustWeighting: async () => ({ trustWeightFloor: 1, trustStale: false })
}))
jest.mock('../../lib/rewardsPool', () => ({ readNextRewardsPool: async () => ({ poolPiconeros: 500_000_000_000n }) }))
jest.mock('../../api/monero/rewardsInflow', () => ({ readRewardsInflow: async () => ({ rewardsPiconeros: 500_000_000_000n, opsPiconeros: 0n, raw: {} }) }))
jest.mock('../../api/monero/rewardsLedger', () => ({ readRewardsWalletLedger: async () => ({ totalNetworkFeesPiconeros: 0n, sweptByDistribution: new Map(), accountingUncertain: false }) }))

let resolvers
beforeEach(() => {
  jest.useFakeTimers({ now: NOW })
  process.env.MONERO_NETWORK = 'stagenet'
  process.env.PLATFORM_REWARDS_ADDRESS = '5' + '7'.repeat(94)
  planCuratorBudget.mockImplementation(async (_tx, { config }) => budgetPlan(config))
  // Each public projection starts cold, without adding test-only cache API.
  jest.isolateModules(() => { resolvers = require('../../api/resolvers/rewards').default })
})
afterEach(() => { jest.useRealTimers() })

async function distribute (options = {}) {
  const fixture = planningModels(options)
  await runDistributionOnce({ models: fixture.models, scheduleOpsSweep: false, sendPayouts: () => { throw new Error('no signing allowed') } })
  return fixture.state
}

test('tight SHADOW combined-cap simulation matches ACTIVE without changing actual curator/referral payouts', async () => {
  const off = await distribute({ config: { ...CONFIG, contributorPoolMode: 'OFF' } })
  const shadow = await distribute({ config: { ...CONFIG, contributorPoolMode: 'SHADOW' } })
  const active = await distribute()
  expect(active.earns.find(e => e.type === 'POST').piconeros).toBe(18_750_000_000n)
  expect(shadow.distribution.contributorParams.scored.find(s => s.rank === 1).share).toBe('18750000000')
  expect(shadow.distribution.contributorParams.allocation).toEqual(active.distribution.contributorParams.allocation)
  expect(shadow.payouts).toEqual(off.payouts)
  expect(shadow.earns).toEqual(off.earns)
  expect(shadow.distribution.contributorDistributedPiconeros).toBe(0n)
})

test.each([
  ['below curator minimum', { contributorShareBps: 5000, contributorWinnerCapBps: 10000, distributionMinPayoutPiconeros: 100_000_000_000n }, {}, '125000000000'],
  ['topN excludes the winner', { distributionTopN: 3 }, { winnerAuthor: 104 }, '30000000000'],
  ['walletless non-winning curator', {}, { noWallet: [104] }, '18750000000']
])('SHADOW uses hypothetical ACTIVE wallet-filtered shares: %s', async (_label, overrides, options, amount) => {
  const config = { ...CONFIG, ...overrides }
  const shadow = await distribute({ config: { ...config, contributorPoolMode: 'SHADOW' }, ...options })
  const active = await distribute({ config, ...options })
  expect(shadow.distribution.contributorParams.scored[0].share).toBe(amount)
  expect(shadow.distribution.contributorParams.allocation).toEqual(active.distribution.contributorParams.allocation)
})

test('a walletless author is not a winner and gets no simulated or actual contributor payment', async () => {
  const shadow = await distribute({ config: { ...CONFIG, contributorPoolMode: 'SHADOW' }, noWallet: [101] })
  const active = await distribute({ noWallet: [101] })
  expect(shadow.distribution.contributorParams.scored).toEqual([])
  expect(shadow.distribution.contributorParams.allocation.paid).toBe('0')
  expect(active.earns.filter(e => e.type === 'POST')).toEqual([])
})

test('tight SHADOW refits unused contributor room just like ACTIVE with the combined cap off', async () => {
  const config = { ...CONFIG, contributorCombinedCapBps: 0 }
  const shadow = await distribute({ config: { ...config, contributorPoolMode: 'SHADOW' } })
  const active = await distribute({ config })
  expect(shadow.distribution.contributorParams.funding.curatorBudget).toBe('470000000000')
  expect(shadow.distribution.contributorParams.funding).toEqual(active.distribution.contributorParams.funding)
  expect(shadow.distribution.appliedCuratorBudgetPiconeros).toBe(500_000_000_000n)
})

test('SHADOW simulation failure rolls back its read and leaves actual curator money untouched', async () => {
  const off = await distribute({ config: { ...CONFIG, contributorPoolMode: 'OFF' } })
  const shadow = await distribute({ config: { ...CONFIG, contributorPoolMode: 'SHADOW' }, hypotheticalError: new Error('hypothetical SQL failed') })
  expect(shadow.payouts).toEqual(off.payouts)
  expect(shadow.distribution.contributorParams.errors).toEqual(['selection_failed'])
})

test.each([
  ['fixed combined split', {}, true, 425_000_000_000n],
  ['unused awards returned', { contributorCombinedCapBps: 0 }, true, 470_000_000_000n],
  ['no winners returns all room', { contributorCombinedCapBps: 0 }, false, 500_000_000_000n],
  ['combined split with no winners', {}, false, 425_000_000_000n]
])('live curator projection equals the upcoming distribution: %s', async (_label, overrides, winners, amount) => {
  const config = { ...CONFIG, ...overrides }
  const { models } = planningModels({ config, winners })
  jest.setSystemTime(new Date('2026-10-18T23:59:00Z'))
  const projection = await resolvers.Query.curatorBudget(null, {}, { models })
  jest.setSystemTime(NOW)
  const actual = await distribute({ config, winners })
  expect(projection.projectedPiconeros).toBe(amount)
  expect(projection.projectedPiconeros).toBe(actual.distribution.appliedCuratorBudgetPiconeros)
  expect(projection.multBps).toBe(Number(amount * 10000n / 566_666_666_667n))
})

test.each(['OFF', 'SHADOW'])('%s projection keeps the original dynamic projection and avoids contributor SQL', async contributorPoolMode => {
  const { models } = planningModels({ config: { ...CONFIG, contributorPoolMode }, selectionError: new Error('must not select') })
  const projection = await resolvers.Query.curatorBudget(null, {}, { models })
  expect(projection.projectedPiconeros).toBe(500_000_000_000n)
})

test('contributor selection failure preserves a valid curator projection and Serializable isolation', async () => {
  const { models, state } = planningModels({ selectionError: new Error('selection failed') })
  const projection = await resolvers.Query.curatorBudget(null, {}, { models })
  expect(projection.projectedPiconeros).toBe(500_000_000_000n)
  expect(state.transactions[0].isolationLevel).toBe('Serializable')
})

test.each([{ code: 'P2034' }, { code: 'P2010', meta: { code: '40001' } }, { code: 'P2010', meta: { code: '40P01' } }])('projection never publishes a dynamic amount after a contributor serialization failure: %j', async selectionError => {
  const { models } = planningModels({ selectionError })
  const projection = await resolvers.Query.curatorBudget(null, {}, { models })
  expect(projection.projectedPiconeros).toBeNull()
  expect(projection.fallbackBudgetPiconeros).toBe(200_000_000_000n)
})

test.each([
  ['ACTIVE', 'ACTIVE', [12, 11]],
  ['SHADOW', 'LEGACY', [12, 11]],
  ['ACTIVE', 'LEGACY', [11]]
])('%s/%s preview uses the next run catch-up/degraded window and exposes only ranks/items', async (contributorPoolMode, curatorBudgetMode, ids) => {
  // Sunday preview of Monday's exact run window.
  jest.setSystemTime(new Date('2026-10-18T23:59:00Z'))
  const config = { ...CONFIG, contributorPoolMode, curatorBudgetMode }
  const { models } = planningModels({ config, catchUp: true })
  const preview = await resolvers.ContributorPool.candidates({}, {}, { models })
  const decision = decideContributorMode(config, budgetPlan(config))
  const { selection } = await selectContributorWinners(models, { decision, budgetPlan: budgetPlan(config), poolPiconeros: 500_000_000_000n, weekStart: NOW, excludedCuratorIds: [] })
  expect(preview).toEqual(ids.map((itemId, i) => ({ rank: i + 1, itemId })))
  expect(preview.map(c => c.itemId)).toEqual(selection.winners.map(w => w.itemId))
})
