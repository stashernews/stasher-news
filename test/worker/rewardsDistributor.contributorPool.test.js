/* eslint-env jest */

import { randomBytes } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { runDistributionOnce } from '@/worker/rewardsDistributor'
import { computeContributorShares } from '@/worker/contributorShares'
import { CURATOR_FALLBACK_CAP_PICONEROS } from '@/lib/rewardsAccounting'
import { alert } from '@/lib/alert'

// Contributor pool inside the weekly distribution. Real SQL, allocation and
// ledger with a fake signer. Seeds users, posts and tips, so run it only against
// the dedicated migrated stasher_contributor_pool_test database:
//   DATABASE_URL=<isolated-db-url> npm test -- --runTestsByPath test/worker/rewardsDistributor.contributorPool.test.js
const ISOLATED_DB = (() => {
  try {
    return ['/stasher_contributor_pool_test'].includes(new URL(process.env.DATABASE_URL).pathname)
  } catch { return false }
})()

jest.mock('../../lib/alert', () => ({ alert: jest.fn() }))
jest.mock('../../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn() },
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn()
}))
jest.mock('../../worker/contributorShares', () => ({
  ...jest.requireActual('../../worker/contributorShares'),
  computeContributorShares: jest.fn((...args) =>
    jest.requireActual('../../worker/contributorShares').computeContributorShares(...args))
}))

const XMR = 1_000_000_000_000n
const CAP = CURATOR_FALLBACK_CAP_PICONEROS
const DAY = 24 * 60 * 60 * 1000
const START = new Date('2026-10-19T00:00:00Z') // Monday 00:00 UTC
const POST_AT = new Date('2026-10-07T12:00:00Z') // inside [START-14d, START-7d)
const TIP = 250_000_000_000n // 0.25 XMR; four equal tippers give T = 1 XMR
// k = 1.5 → curator target 1.5 XMR; contributor target = 1.5 × 1500 / 8500
const CONTRIBUTOR_TARGET = 1_500_000_000_000n * 1500n / 8500n

;(ISOLATED_DB ? describe : describe.skip)('contributor pool in the distributor (isolated DB, fake signer)', () => {
  const db = new PrismaClient()
  const created = { users: [], accounts: [], items: [], distributions: [] }
  const savedEnv = {}
  let savedConfig
  let authorId
  let curators
  let recipient

  beforeAll(async () => {
    for (const key of ['MONERO_NETWORK', 'PLATFORM_REWARDS_ADDRESS']) savedEnv[key] = process.env[key]
    process.env.MONERO_NETWORK = 'stagenet'
    process.env.PLATFORM_REWARDS_ADDRESS = '5' + '7'.repeat(94)
    await db.platformFeeConfig.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } })
    savedConfig = await db.platformFeeConfig.findUnique({ where: { id: 1 } })
  })

  beforeEach(async () => {
    jest.useFakeTimers({
      now: START,
      doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout']
    })
    expect(await db.rewardDistribution.count()).toBe(0)
    await setConfig()
    alert.mockReset()
    computeContributorShares.mockClear()
    curators = []
    await seedBase()
  })

  afterEach(async () => {
    await cleanupFixtures()
    jest.useRealTimers()
  })

  afterAll(async () => {
    // Put back the whole singleton row: other suites in this database expect
    // its original percentages and budget settings.
    const { id, ...original } = savedConfig
    await db.platformFeeConfig.update({ where: { id }, data: original })
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await db.$disconnect()
  })

  async function setConfig (overrides = {}) {
    await db.platformFeeConfig.update({
      where: { id: 1 },
      data: {
        curatorTrustWeightFloor: 1.0,
        distributionTopN: 10,
        distributionMinPayoutPiconeros: 1_000_000_000n,
        postingFeeRewardsPct: 100,
        curatorBudgetMode: 'LEGACY',
        curatorBudgetMultBps: 15000,
        curatorBudgetDrawdownWeeks: 13,
        curatorBudgetAvgPeriods: 4,
        curatorTipCapShareBps: 2500,
        curatorBreakerRatioBps: 25000,
        curatorBreakerFloorMedianPeriods: 12,
        curatorBreakerArmPeriods: 4,
        contributorPoolMode: 'OFF',
        contributorShareBps: 1500,
        contributorTopN: 5,
        contributorWinnerCapBps: 4000,
        contributorCombinedCapBps: 0,
        ...overrides
      }
    })
  }

  async function cleanupFixtures () {
    await db.earn.deleteMany({ where: { distributionId: { in: created.distributions } } })
    await db.rewardPayout.deleteMany({ where: { distributionId: { in: created.distributions } } })
    await db.rewardDistribution.deleteMany({ where: { id: { in: created.distributions } } })
    await db.observedTip.deleteMany({ where: { postId: { in: created.items } } })
    await db.feeObservation.deleteMany({ where: { txHash: { startsWith: 'cpt-fee-' } } })
    await db.item.deleteMany({ where: { id: { in: created.items } } })
    await db.userSubTrust.deleteMany({ where: { userId: { in: created.users } } })
    await db.moneroAccount.deleteMany({ where: { id: { in: created.accounts } } })
    await db.user.updateMany({ where: { id: { in: created.users } }, data: { referrerId: null } })
    await db.user.deleteMany({ where: { id: { in: created.users } } })
    for (const ids of Object.values(created)) ids.length = 0
  }

  async function createUser () {
    const user = await db.user.create({ data: {} })
    created.users.push(user.id)
    // old enough for the 14-day account-age rule at POST_AT
    await db.$executeRaw`UPDATE users SET created_at = ${new Date('2026-06-01T00:00:00Z')} WHERE id = ${user.id}::int`
    return user.id
  }

  async function createAccount (ownerUserId, label, address = '5' + randomBytes(47).toString('hex')) {
    const account = await db.moneroAccount.create({
      data: { ownerUserId, label, address, network: 'STAGENET', status: 'ACTIVE' }
    })
    created.accounts.push(account.id)
    return account
  }

  async function seedBase () {
    authorId = await createUser()
    recipient = await createAccount(null, 'author')
    await createAccount(null, 'platform_rewards', process.env.PLATFORM_REWARDS_ADDRESS)
    for (let i = 0; i < 4; i++) {
      const id = await createUser()
      await createAccount(id, `curator-${i}`)
      curators.push(id)
    }
  }

  async function createItem (userId, createdAt, { text = null } = {}) {
    const [item] = await db.$queryRaw`
      INSERT INTO "Item" ("userId", title, text, "weightedVotes", created_at)
      VALUES (${userId}::int, 'contributor pool test post', ${text}, 10, ${createdAt}) RETURNING id::int`
    created.items.push(item.id)
    await db.$executeRaw`UPDATE "Item" SET path = ${String(item.id)}::ltree WHERE id = ${item.id}::int`
    return item
  }

  async function seedTip (tipperId, postId, piconeros, confirmedAt) {
    await db.observedTip.create({
      data: {
        postId,
        tipperId,
        recipientAccountId: recipient.id,
        paymentId: randomBytes(8).toString('hex'),
        txHash: randomBytes(32).toString('hex'),
        piconeros,
        state: 'CONFIRMED',
        confirmedAt
      }
    })
  }

  // Curator fixture: four curators tipping the author's posts yesterday.
  async function seedItemsAndTips () {
    const createdAt = new Date(Date.now() - DAY)
    for (let i = 0; i < curators.length; i++) {
      const item = await createItem(authorId, createdAt)
      await seedTip(curators[i], item.id, TIP, createdAt)
    }
  }

  // An original post in the candidate window with `tippers` trusted tippers
  // (trust 0.5, 1 mXMR each). Returns { itemId, authorId }.
  async function seedWinner ({ author, tippers = 3, at = POST_AT } = {}) {
    const owner = author ?? await createUser()
    if (author == null) await createAccount(owner, `winner-${owner}`)
    const item = await createItem(owner, at, { text: 'original prose '.repeat(100) })
    for (let k = 0; k < tippers; k++) {
      const t = await createUser()
      await db.userSubTrust.create({ data: { subName: 'stasher', userId: t, zapPostTrust: 0.5 } })
      await seedTip(t, item.id, 1_000_000_000n, new Date(at.getTime() + 3600_000))
    }
    return { itemId: item.id, authorId: owner }
  }

  async function seedInflow (piconeros) {
    await db.feeObservation.create({
      data: {
        feeType: 'POSTING',
        txHash: 'cpt-fee-' + randomBytes(16).toString('hex'),
        recipientMajor: 3,
        recipientMinor: 1,
        piconeros,
        state: 'CONFIRMED',
        walletReceipt: true,
        confirmedAt: new Date(Date.now() - 60 * 60 * 1000)
      }
    })
  }

  async function seedHistory ({ count = 4, t = XMR, income = XMR, lastRollover = 99n * XMR } = {}) {
    for (let i = 0; i < count; i++) {
      const periodEnd = new Date(START.getTime() - (count - i) * 7 * DAY)
      const isLast = i === count - 1
      const row = await db.rewardDistribution.create({
        data: {
          periodStart: new Date(periodEnd.getTime() - 7 * DAY),
          periodEnd,
          poolPiconeros: 0n,
          distributedPiconeros: 0n,
          rolledOverPiconeros: isLast ? lastRollover : 0n,
          payoutCount: 0,
          status: 'COMPLETE',
          rawTipPiconeros: t,
          trustedTipPiconeros: t,
          incomePiconeros: income,
          multBps: 15000,
          reservePiconeros: 5n * XMR,
          spendLimitPiconeros: XMR,
          dynamicBudgetPiconeros: t * 15000n / 10000n,
          dynamicBudgetMode: 'FULL',
          curatorBudgetMode: 'LEGACY'
        }
      })
      created.distributions.push(row.id)
    }
  }

  async function fakeSigner (payouts) {
    await db.rewardPayout.updateMany({
      where: { id: { in: payouts.map(p => p.id) }, state: 'QUEUED' },
      data: { state: 'SENT', txHash: 'ab'.repeat(32) }
    })
    return { sent: payouts.length, skipped: 0, failed: 0 }
  }

  async function run () {
    const distribution = await runDistributionOnce({ models: db, sendPayouts: fakeSigner, scheduleOpsSweep: false })
    if (!created.distributions.includes(distribution.id)) created.distributions.push(distribution.id)
    return distribution
  }

  async function deleteDistribution (distribution) {
    await db.earn.deleteMany({ where: { distributionId: distribution.id } })
    await db.rewardPayout.deleteMany({ where: { distributionId: distribution.id } })
    await db.rewardDistribution.delete({ where: { id: distribution.id } })
    created.distributions = created.distributions.filter(id => id !== distribution.id)
  }

  async function expectConserved (distribution) {
    const earns = await db.earn.aggregate({ where: { distributionId: distribution.id }, _sum: { piconeros: true } })
    expect(earns._sum.piconeros ?? 0n).toBe(distribution.distributedPiconeros)
    expect(distribution.payouts.reduce((sum, p) => sum + p.piconeros, 0n)).toBe(distribution.distributedPiconeros)
    expect(distribution.distributedPiconeros + distribution.rolledOverPiconeros).toBe(distribution.poolPiconeros)
  }

  const curatorPayoutsByIndex = distribution =>
    curators.map(id => distribution.payouts.filter(p => p.curatorId === id).map(p => p.piconeros))

  const postEarns = distribution => db.earn.findMany({ where: { distributionId: distribution.id, type: 'POST' }, orderBy: { rank: 'asc' } })

  // Shared fixture for the ACTIVE tests: a FULL week where the curator budget
  // is the full 1.5 XMR target.
  async function seedActiveWeek (winners = 3) {
    await seedHistory()
    await seedItemsAndTips()
    await seedInflow(XMR)
    const out = []
    for (let i = 0; i < winners; i++) out.push(await seedWinner())
    return out
  }

  test('OFF runs nothing and records only the mode', async () => {
    await seedActiveWeek()
    const distribution = await run()

    expect(distribution.contributorPoolMode).toBe('OFF')
    expect(distribution.contributorParams).toBeNull()
    expect(distribution.contributorBudgetPiconeros).toBeNull()
    expect(distribution.distributedPiconeros).toBe(CAP)
    expect(await postEarns(distribution)).toHaveLength(0)
    expect(computeContributorShares).not.toHaveBeenCalled()
  })

  test('SHADOW leaves curator money untouched and records would-have-won shares', async () => {
    await seedActiveWeek()
    const baseline = await run()
    const baselineAmounts = curatorPayoutsByIndex(baseline)
    await deleteDistribution(baseline)

    await setConfig({ contributorPoolMode: 'SHADOW' })
    const distribution = await run()

    expect(distribution.contributorPoolMode).toBe('SHADOW')
    expect(curatorPayoutsByIndex(distribution)).toEqual(baselineAmounts)
    expect(distribution.distributedPiconeros).toBe(baseline.distributedPiconeros)
    expect(distribution.appliedCuratorBudgetPiconeros).toBe(baseline.appliedCuratorBudgetPiconeros)
    expect(distribution.contributorBudgetPiconeros).toBe(0n)
    expect(distribution.contributorDistributedPiconeros).toBe(0n)
    expect(await postEarns(distribution)).toHaveLength(0)
    const params = distribution.contributorParams
    expect(params.qualifying).toBe(3)
    const winners = params.scored.filter(s => s.rank != null)
    expect(winners).toHaveLength(3)
    for (const winner of winners) {
      const tips = await db.observedTip.findMany({ where: { postId: winner.itemId, state: 'CONFIRMED' }, select: { tipperId: true } })
      expect(winner.trustedTipperIds).toEqual(tips.map(t => t.tipperId).sort((a, b) => a - b))
      expect(winner.trustedTipperIds).toHaveLength(winner.n)
    }
    expect(winners.every(w => BigInt(w.share) > 0n)).toBe(true)
    // the recorded summary is the would-be split, not zeros
    const wouldPay = winners.reduce((a, w) => a + BigInt(w.share), 0n)
    expect(BigInt(params.allocation.paid)).toBe(wouldPay)
    expect(BigInt(params.allocation.paid) + BigInt(params.allocation.rolledOver)).toBe(BigInt(params.funding.contributorBudget))
    expect(wouldPay).toBeGreaterThan(0n)
    await expectConserved(distribution)
  })

  test('ACTIVE in a FULL week keeps curator payouts and pays the winners', async () => {
    await setConfig({ curatorBudgetMode: 'ACTIVE' })
    const winners = await seedActiveWeek()
    const baseline = await run()
    const baselineAmounts = curatorPayoutsByIndex(baseline)
    expect(baseline.appliedCuratorBudgetPiconeros).toBe(15n * XMR / 10n)
    await deleteDistribution(baseline)

    await setConfig({ curatorBudgetMode: 'ACTIVE', contributorPoolMode: 'ACTIVE' })
    const distribution = await run()

    expect(distribution.contributorPoolMode).toBe('ACTIVE')
    expect(curatorPayoutsByIndex(distribution)).toEqual(baselineAmounts)
    expect(distribution.appliedCuratorBudgetPiconeros).toBe(15n * XMR / 10n)
    expect(distribution.contributorTargetPiconeros).toBe(CONTRIBUTOR_TARGET)
    expect(distribution.contributorBudgetPiconeros).toBe(CONTRIBUTOR_TARGET)
    const earns = await postEarns(distribution)
    expect(earns).toHaveLength(3)
    expect(earns.map(e => e.rank)).toEqual([1, 2, 3])
    expect(earns.map(e => e.typeId).sort()).toEqual(winners.map(w => w.itemId).sort())
    const paid = earns.reduce((a, e) => a + e.piconeros, 0n)
    expect(distribution.contributorDistributedPiconeros).toBe(paid)
    expect(paid).toBeGreaterThan(0n)
    expect(paid).toBeLessThanOrEqual(CONTRIBUTOR_TARGET)
    expect(distribution.payouts).toHaveLength(baseline.payoutCount + 3)
    await expectConserved(distribution)
  })

  // Tight week: pool 2 XMR, limit ~0.979 XMR < the 1.5 XMR curator target.
  async function seedTightWeek (winners) {
    await setConfig({ curatorBudgetMode: 'ACTIVE', contributorPoolMode: 'ACTIVE' })
    await seedHistory({ lastRollover: XMR })
    await seedItemsAndTips()
    await seedInflow(XMR)
    for (let i = 0; i < winners; i++) await seedWinner()
  }

  test('ACTIVE in a DRAWDOWN week pays winners first and curators get the rest of the limit', async () => {
    await seedTightWeek(3)
    const distribution = await run()

    expect(distribution.dynamicBudgetMode).toBe('DRAWDOWN')
    const limit = distribution.spendLimitPiconeros
    const paid = distribution.contributorDistributedPiconeros
    expect(paid).toBeGreaterThan(0n)
    expect(paid).toBeLessThanOrEqual(distribution.contributorBudgetPiconeros)
    expect(distribution.contributorBudgetPiconeros).toBeLessThan(CONTRIBUTOR_TARGET)
    // curators take exactly what the limit has left after the winners
    expect(distribution.appliedCuratorBudgetPiconeros).toBe(limit - paid)
    expect(distribution.appliedCuratorBudgetPiconeros + paid).toBeLessThanOrEqual(limit)
    // the recorded effective multiple follows the budget actually applied
    expect(distribution.multBps).toBe(Number(distribution.appliedCuratorBudgetPiconeros * 10000n / distribution.tipT4Piconeros))
    await expectConserved(distribution)
  })

  test('ACTIVE in a DRAWDOWN week with no winners leaves curators the whole limit', async () => {
    await seedTightWeek(0)
    const distribution = await run()

    expect(distribution.dynamicBudgetMode).toBe('DRAWDOWN')
    expect(distribution.contributorDistributedPiconeros).toBe(0n)
    expect(distribution.appliedCuratorBudgetPiconeros).toBe(distribution.spendLimitPiconeros)
    expect(await postEarns(distribution)).toHaveLength(0)
    await expectConserved(distribution)
  })

  test('ACTIVE with the curator side not ACTIVE behaves as SHADOW', async () => {
    await setConfig({ curatorBudgetMode: 'SHADOW', contributorPoolMode: 'ACTIVE' })
    await seedActiveWeek()
    const distribution = await run()
    expect(distribution.contributorPoolMode).toBe('SHADOW')
    expect(distribution.contributorBudgetPiconeros).toBe(0n)
    expect(distribution.distributedPiconeros).toBe(CAP)
    expect(await postEarns(distribution)).toHaveLength(0)
  })

  test('an invalid tuning value while OFF is ignored: no alert, no record', async () => {
    await setConfig({ contributorPoolMode: 'OFF', contributorTopN: 0 })
    await seedActiveWeek()
    const distribution = await run()
    expect(distribution.contributorPoolMode).toBe('OFF')
    expect(distribution.contributorParams).toBeNull()
    expect(alert.mock.calls.some(([, , , opts = {}]) => opts.dedupeKey === 'contributor-pool-config-invalid')).toBe(false)
  })

  test('invalid contributor config fails closed to OFF and alerts after commit', async () => {
    await setConfig({ contributorPoolMode: 'ACTIVE', contributorShareBps: 0 })
    await seedActiveWeek()
    const distribution = await run()
    expect(distribution.contributorPoolMode).toBe('OFF')
    expect(distribution.contributorBudgetPiconeros).toBe(0n)
    expect(distribution.contributorParams.errors).toContain('shareBps_out_of_range')
    expect(computeContributorShares).not.toHaveBeenCalled()
    expect(alert.mock.calls.some(([, , , opts = {}]) => opts.dedupeKey === 'contributor-pool-config-invalid')).toBe(true)
  })

  test('a contributor SQL failure leaves curators equal to OFF, budget 0, and alerts', async () => {
    await setConfig({ curatorBudgetMode: 'ACTIVE' })
    await seedActiveWeek()
    const baseline = await run()
    const baselineAmounts = curatorPayoutsByIndex(baseline)
    await deleteDistribution(baseline)

    await setConfig({ curatorBudgetMode: 'ACTIVE', contributorPoolMode: 'ACTIVE' })
    computeContributorShares.mockImplementationOnce(async () => { throw new Error('contributor sql broke') })
    const distribution = await run()

    expect(curatorPayoutsByIndex(distribution)).toEqual(baselineAmounts)
    expect(distribution.appliedCuratorBudgetPiconeros).toBe(15n * XMR / 10n)
    expect(distribution.contributorBudgetPiconeros).toBe(0n)
    expect(distribution.contributorParams.errors).toEqual(['selection_failed'])
    expect(await postEarns(distribution)).toHaveLength(0)
    expect(alert.mock.calls.some(([, , , opts = {}]) => opts.dedupeKey === `contributor-pool-failed-${distribution.id}`)).toBe(true)
    await expectConserved(distribution)
  })

  test('a REAL failing SQL statement is rolled back by the savepoint and the run still completes', async () => {
    await setConfig({ curatorBudgetMode: 'ACTIVE' })
    await seedActiveWeek()
    const baseline = await run()
    const baselineAmounts = curatorPayoutsByIndex(baseline)
    await deleteDistribution(baseline)

    await setConfig({ curatorBudgetMode: 'ACTIVE', contributorPoolMode: 'ACTIVE' })
    // Postgres aborts the transaction (25P02) until ROLLBACK TO SAVEPOINT runs;
    // the curator ledger write after it only succeeds if the savepoint recovers.
    computeContributorShares.mockImplementationOnce(async tx => {
      await tx.$queryRaw`SELECT 1 / 0`
    })
    const distribution = await run()

    expect(curatorPayoutsByIndex(distribution)).toEqual(baselineAmounts)
    expect(distribution.contributorBudgetPiconeros).toBe(0n)
    expect(distribution.contributorParams.errors).toEqual(['selection_failed'])
    expect(await postEarns(distribution)).toHaveLength(0)
    await expectConserved(distribution)
  })

  test.each([
    ['P2034 write conflict', { code: 'P2034' }],
    ['40001 serialization failure', { code: 'P2010', meta: { code: '40001' } }]
  ])('%s inside the contributor savepoint escapes and aborts the run', async (_label, error) => {
    await setConfig({ curatorBudgetMode: 'ACTIVE', contributorPoolMode: 'ACTIVE' })
    await seedActiveWeek()
    computeContributorShares.mockImplementationOnce(async () => { throw error })
    await expect(run()).rejects.toMatchObject({ code: error.code })
    expect(await db.rewardDistribution.count({ where: { periodEnd: { gte: START } } })).toBe(0)
  })

  test('a winner who is also a curator gets two payout rows and the right Earn rows', async () => {
    await setConfig({ curatorBudgetMode: 'ACTIVE', contributorPoolMode: 'ACTIVE' })
    await seedHistory()
    await seedItemsAndTips()
    await seedInflow(XMR)
    const both = await seedWinner({ author: curators[0] })
    await seedWinner()
    await seedWinner()

    const distribution = await run()

    const rows = distribution.payouts.filter(p => p.curatorId === curators[0])
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map(r => r.recipientAddress)).size).toBe(1)
    const earns = await db.earn.findMany({ where: { distributionId: distribution.id, userId: curators[0] } })
    expect(earns.filter(e => e.type === 'POST')).toHaveLength(1)
    expect(earns.find(e => e.type === 'POST').typeId).toBe(both.itemId)
    expect(earns.filter(e => e.type === 'TIP_POST').length + earns.filter(e => e.type === 'TIP_COMMENT').length).toBeGreaterThan(0)
    await expectConserved(distribution)
  })

  test('the combined cap trims only when set above zero', async () => {
    await seedHistory()
    await seedItemsAndTips()
    await seedInflow(XMR)
    await seedWinner({ author: curators[0] })
    await seedWinner()
    await seedWinner()

    await setConfig({ curatorBudgetMode: 'ACTIVE', contributorPoolMode: 'ACTIVE', contributorCombinedCapBps: 0 })
    const off = await run()
    expect((await postEarns(off)).some(e => e.userId === curators[0])).toBe(true)
    await deleteDistribution(off)

    // 5% of (curator + contributor budget) is below curators[0]'s curator payout
    await setConfig({ curatorBudgetMode: 'ACTIVE', contributorPoolMode: 'ACTIVE', contributorCombinedCapBps: 500 })
    const on = await run()
    expect((await postEarns(on)).some(e => e.userId === curators[0])).toBe(false)
    expect(on.contributorParams.scored.flatMap(s => s.trims).some(t => t.rule === 'combined_cap')).toBe(true)
    await expectConserved(on)
  })

  test('shares below the minimum payout roll over', async () => {
    await setConfig({ curatorBudgetMode: 'ACTIVE', contributorPoolMode: 'ACTIVE', distributionMinPayoutPiconeros: 200_000_000_000n })
    await seedActiveWeek()
    const distribution = await run()
    expect(await postEarns(distribution)).toHaveLength(0)
    expect(distribution.contributorDistributedPiconeros).toBe(0n)
    expect(distribution.contributorParams.scored.flatMap(s => s.trims).some(t => t.rule === 'min_payout')).toBe(true)
    await expectConserved(distribution)
  })

  test('contributor payouts carry no referral commission', async () => {
    await setConfig({ curatorBudgetMode: 'ACTIVE', contributorPoolMode: 'ACTIVE' })
    const referrer = await createUser()
    await createAccount(referrer, 'referrer')
    const winners = await seedActiveWeek()
    await db.user.update({ where: { id: winners[0].authorId }, data: { referrerId: referrer } })

    const distribution = await run()

    expect(await postEarns(distribution)).toHaveLength(3)
    const referralEarns = await db.earn.findMany({ where: { distributionId: distribution.id, userId: referrer } })
    expect(referralEarns).toHaveLength(0)
    await expectConserved(distribution)
  })

  test('a skipped contributor week is scored in the next run and raises a warning', async () => {
    await setConfig({ curatorBudgetMode: 'ACTIVE', contributorPoolMode: 'ACTIVE' })
    await seedActiveWeek()
    // the last scored window ended 2026-09-28, so 09-28..10-05 was never scored
    await db.rewardDistribution.updateMany({
      where: { periodEnd: new Date(START.getTime() - 21 * DAY) },
      data: { contributorParams: { window: ['2026-09-21T00:00:00.000Z', '2026-09-28T00:00:00.000Z'] } }
    })
    const skipped = await seedWinner({ at: new Date('2026-09-30T12:00:00Z') })

    const distribution = await run()

    expect(distribution.contributorParams.catchUpWeeks).toBe(1)
    expect(distribution.contributorParams.window[0]).toBe('2026-09-28T00:00:00.000Z')
    const earns = await postEarns(distribution)
    expect(earns).toHaveLength(4)
    expect(earns.map(e => e.typeId)).toContain(skipped.itemId)
    expect(alert.mock.calls.some(([level, , , opts = {}]) =>
      level === 'warn' && opts.dedupeKey === `contributor-pool-catch-up-${distribution.id}`)).toBe(true)
    await expectConserved(distribution)
  })

  test('a normal week scores one window and raises no catch-up warning', async () => {
    await setConfig({ curatorBudgetMode: 'ACTIVE', contributorPoolMode: 'ACTIVE' })
    await seedActiveWeek()
    const distribution = await run()
    expect(distribution.contributorParams.catchUpWeeks).toBe(0)
    expect(distribution.contributorParams.window).toEqual(['2026-10-05T00:00:00.000Z', '2026-10-12T00:00:00.000Z'])
    expect(alert.mock.calls.some(([, , , opts = {}]) => opts.dedupeKey?.startsWith('contributor-pool-catch-up-'))).toBe(false)
  })

  test.each(['selection failure', 'invalid config'])('catches up the first %s without an earlier scored window', async failure => {
    await setConfig({ curatorBudgetMode: 'ACTIVE', contributorPoolMode: 'ACTIVE', ...(failure === 'invalid config' ? { contributorShareBps: 0 } : {}) })
    const winners = await seedActiveWeek()
    if (failure === 'selection failure') computeContributorShares.mockImplementationOnce(async tx => { await tx.$queryRaw`SELECT 1 / 0` })
    const first = await run()
    expect(first.contributorDistributedPiconeros).toBe(0n)
    expect(await postEarns(first)).toHaveLength(0)
    await expectConserved(first)

    jest.setSystemTime(new Date(START.getTime() + 7 * DAY))
    await setConfig({ curatorBudgetMode: 'ACTIVE', contributorPoolMode: 'ACTIVE' })
    await seedItemsAndTips()
    await seedInflow(XMR)
    const recovered = await run()
    expect(recovered.contributorParams.catchUpWeeks).toBe(1)
    expect(recovered.contributorParams.window).toEqual(['2026-10-05T00:00:00.000Z', '2026-10-19T00:00:00.000Z'])
    expect((await postEarns(recovered)).map(e => e.typeId).sort()).toEqual(winners.map(w => w.itemId).sort())
    await expectConserved(recovered)
    expect((await db.rewardDistribution.findUnique({ where: { id: first.id } })).contributorParams).toEqual(first.contributorParams)
    const replay = await run()
    expect(replay.id).toBe(recovered.id)
    expect(await postEarns(recovered)).toHaveLength(winners.length)
  })

  test('a week configured ACTIVE that degrades to SHADOW is not marked scored; the next ACTIVE run catches it up', async () => {
    await seedActiveWeek()
    // week 1: contributor ACTIVE but the curator budget is SHADOW -> runs as SHADOW
    await setConfig({ curatorBudgetMode: 'SHADOW', contributorPoolMode: 'ACTIVE' })
    const first = await run()
    expect(first.contributorPoolMode).toBe('SHADOW')
    expect(first.contributorParams.window).toBeUndefined()
    expect(first.contributorParams.windowNotScored).toEqual(['2026-10-05T00:00:00.000Z', '2026-10-12T00:00:00.000Z'])

    // week 2: the curator budget is ACTIVE again -> the degraded week is caught up
    jest.setSystemTime(new Date(START.getTime() + 7 * DAY))
    await setConfig({ curatorBudgetMode: 'ACTIVE', contributorPoolMode: 'ACTIVE' })
    await seedItemsAndTips()
    await seedInflow(XMR)
    const second = await run()
    expect(second.contributorPoolMode).toBe('ACTIVE')
    expect(second.contributorParams.catchUpWeeks).toBe(1)
    expect(second.contributorParams.window).toEqual(['2026-10-05T00:00:00.000Z', '2026-10-19T00:00:00.000Z'])
    expect((await postEarns(second)).length).toBeGreaterThanOrEqual(3) // week 1's winners are paid now
    expect(alert.mock.calls.some(([level, , , opts = {}]) =>
      level === 'warn' && opts.dedupeKey === `contributor-pool-catch-up-${second.id}`)).toBe(true)
    await expectConserved(second)
  })

  test('a lasting ACTIVE->SHADOW degradation scores one week each run and never warns', async () => {
    await seedActiveWeek()
    await setConfig({ curatorBudgetMode: 'SHADOW', contributorPoolMode: 'ACTIVE' })
    await run()
    jest.setSystemTime(new Date(START.getTime() + 7 * DAY))
    await seedItemsAndTips()
    await seedInflow(XMR)
    alert.mockClear()
    const second = await run()
    expect(second.contributorPoolMode).toBe('SHADOW')
    expect(second.contributorParams.catchUpWeeks).toBe(0)
    expect(second.contributorParams.windowNotScored).toEqual(['2026-10-12T00:00:00.000Z', '2026-10-19T00:00:00.000Z'])
    expect(alert.mock.calls.some(([, , , opts = {}]) => opts.dedupeKey?.startsWith('contributor-pool-catch-up-'))).toBe(false)
  })

  test('a tight ACTIVE week with the combined cap on uses the configured split and stays within the limit', async () => {
    await seedTightWeek(3)
    await setConfig({ curatorBudgetMode: 'ACTIVE', contributorPoolMode: 'ACTIVE', contributorCombinedCapBps: 9000 })
    const distribution = await run()

    expect(distribution.dynamicBudgetMode).toBe('DRAWDOWN')
    const limit = distribution.spendLimitPiconeros
    const applied = distribution.appliedCuratorBudgetPiconeros
    const budget = distribution.contributorBudgetPiconeros
    // Configured split: both budgets are scaled by the same factor.
    expect(applied + budget).toBeLessThanOrEqual(limit)
    expect(Number(budget) / Number(applied + budget)).toBeCloseTo(0.15, 4)
    expect(distribution.contributorDistributedPiconeros).toBeLessThanOrEqual(budget)
    // the recorded multiple follows the budget actually applied
    expect(distribution.multBps).toBe(Number(applied * 10000n / distribution.tipT4Piconeros))
    await expectConserved(distribution)
  })

  test('SHADOW in a tight week records the would-be split and leaves curators the whole limit', async () => {
    await seedTightWeek(3)
    await setConfig({ curatorBudgetMode: 'ACTIVE', contributorPoolMode: 'SHADOW' })
    const distribution = await run()
    expect(distribution.dynamicBudgetMode).toBe('DRAWDOWN')
    expect(distribution.contributorPoolMode).toBe('SHADOW')
    expect(distribution.appliedCuratorBudgetPiconeros).toBe(distribution.spendLimitPiconeros)
    expect(distribution.contributorDistributedPiconeros).toBe(0n)
    expect(BigInt(distribution.contributorParams.allocation.paid)).toBeGreaterThan(0n)
    expect(await postEarns(distribution)).toHaveLength(0)
    await expectConserved(distribution)
  })

  test('tight SHADOW combined caps simulate ACTIVE curator rows without making contributor payments', async () => {
    await seedTightWeek(0)
    await seedWinner({ author: curators[0] })
    await seedWinner()
    await seedWinner()
    await setConfig({ curatorBudgetMode: 'ACTIVE', contributorPoolMode: 'OFF', contributorCombinedCapBps: 2500 })
    const baseline = await run()
    const baselineAmounts = curatorPayoutsByIndex(baseline)
    await deleteDistribution(baseline)

    await setConfig({ curatorBudgetMode: 'ACTIVE', contributorPoolMode: 'SHADOW', contributorCombinedCapBps: 2500 })
    const shadow = await run()
    expect(curatorPayoutsByIndex(shadow)).toEqual(baselineAmounts)
    expect(shadow.contributorDistributedPiconeros).toBe(0n)
    expect(await postEarns(shadow)).toHaveLength(0)
    await expectConserved(shadow)
    const simulated = shadow.contributorParams.scored.filter(s => s.rank != null)
    expect(BigInt(simulated.find(s => s.authorId === curators[0]).share)).toBeGreaterThan(0n)
    await deleteDistribution(shadow)

    await setConfig({ curatorBudgetMode: 'ACTIVE', contributorPoolMode: 'ACTIVE', contributorCombinedCapBps: 2500 })
    const active = await run()
    expect(active.contributorParams.scored.filter(s => s.rank != null)).toEqual(simulated)
    await expectConserved(active)
  })

  test('a same-week rerun reuses the distribution and writes no duplicate contributor rows', async () => {
    await setConfig({ curatorBudgetMode: 'ACTIVE', contributorPoolMode: 'ACTIVE' })
    await seedActiveWeek()
    const first = await run()
    const again = await run()
    expect(again.id).toBe(first.id)
    expect(await postEarns(first)).toHaveLength(3)
    expect(await db.rewardPayout.count({ where: { distributionId: first.id } })).toBe(first.payouts.length)
  })
})
