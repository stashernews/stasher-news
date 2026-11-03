/* eslint-env jest */
import { PrismaClient } from '@prisma/client'
import { performance } from 'node:perf_hooks'
import { adminOverview } from '@/lib/admin/overview'
import { HEALTH_STALE_MS, readPendingTips, readFailedJobs, readLatestDistribution } from '@/lib/metrics'
import { FIELDS } from '@/lib/admin/fields'

test('overview and gauges share the same DB-backed count and latest-distribution readers', async () => {
  const models = {
    observedTip: { count: async input => { expect(input).toEqual({ where: { state: 'PENDING' } }); return 7 } },
    $queryRaw: async () => [{ failed: 3 }],
    rewardDistribution: { findFirst: async input => { expect(input).toEqual({ orderBy: { periodEnd: 'desc' } }); return { status: 'COMPLETE' } } }
  }
  expect(await readPendingTips(models)).toBe(7)
  expect(await readFailedJobs(models)).toBe(3)
  expect(await readLatestDistribution(models)).toEqual({ status: 'COMPLETE' })
})

const isolated = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_rewards_dynamic_test' } catch { return false }
})()

;(isolated ? describe : describe.skip)('admin overview (isolated DB)', () => {
  const models = new PrismaClient()
  const env = { ...process.env }
  const address = '5AWPhvfMuvWeePRNT192gwa9m63XHdzBmMxfizUhBJedJSqA1Y1BViTETV6uxyCS8Zf8Tz2KKEhHC8FjSRvuDgsd2JuAX6J'
  let saved, fetchSpy, account, existingAccount, rewardAccounts
  beforeAll(async () => {
    saved = await models.healthSnapshot.findUnique({ where: { id: 1 } })
    rewardAccounts = await models.moneroAccount.findMany({ where: { label: 'platform_rewards', network: 'STAGENET' } })
    for (const row of rewardAccounts) await models.moneroAccount.update({ where: { id: row.id }, data: { label: 'admin-overview-fixture-saved' } })
    existingAccount = await models.moneroAccount.findUnique({ where: { address_network: { address, network: 'STAGENET' } } })
    account = await models.moneroAccount.upsert({ where: { address_network: { address, network: 'STAGENET' } }, create: { address, label: 'platform_rewards', network: 'STAGENET' }, update: { label: 'platform_rewards' } })
    process.env.MONERO_NETWORK = 'stagenet'
    process.env.PLATFORM_REWARDS_ADDRESS = address
  })
  beforeEach(() => { fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() => { throw new Error('overview must not call the network') }) })
  afterEach(() => fetchSpy.mockRestore())
  afterAll(async () => {
    if (saved) await models.healthSnapshot.upsert({ where: { id: 1 }, create: saved, update: saved })
    else await models.healthSnapshot.deleteMany({ where: { id: 1 } })
    if (existingAccount) await models.moneroAccount.update({ where: { id: account.id }, data: { label: existingAccount.label } })
    else if (account) await models.moneroAccount.delete({ where: { id: account.id } })
    for (const row of rewardAccounts ?? []) await models.moneroAccount.update({ where: { id: row.id }, data: { label: row.label } })
    process.env = { ...env }
    await models.$disconnect()
  })
  test('reports stale health safely, rollout modes, DB-ledger treasury and seven-day growth within 200ms', async () => {
    const staleAt = new Date(Date.now() - HEALTH_STALE_MS - 1000)
    await models.healthSnapshot.upsert({ where: { id: 1 }, create: { id: 1, lws: true, monerod: true, updatedAt: staleAt }, update: { lws: true, monerod: true, updatedAt: staleAt } })
    await adminOverview(models) // warm the local query engine, not an app cache
    const start = performance.now()
    const result = await adminOverview(models)
    expect(performance.now() - start).toBeLessThan(200)
    expect(result.health).toMatchObject({ stale: true, lws: null, monerod: null })
    expect(result.rolloutModes).toEqual([expect.objectContaining({ key: 'curatorBudgetMode', storedValue: 'LEGACY', effectiveValue: 'LEGACY' })])
    expect(result.activity.tips).toHaveLength(7)
    expect(result.activity.tips.every(point => typeof point.piconeros === 'string')).toBe(true)
    expect(result).toHaveProperty('pendingTips')
    expect(result).toHaveProperty('failedJobs')
    expect(result).toHaveProperty('workerCompletedAt')
    expect(result).toHaveProperty('treasury')
    expect(result.treasury.available).toBe(true)
    expect(result.treasury.balancePiconeros).toEqual({ piconeros: expect.any(String), xmr: expect.any(String) })
    expect(JSON.stringify(result)).not.toContain('viewKey')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  test('missing rewards registration is unknown rather than a fabricated zero balance', async () => {
    await models.moneroAccount.update({ where: { id: account.id }, data: { label: 'admin-overview-temporarily-unregistered' } })
    try {
      const result = await adminOverview(models)
      expect(result.treasury).toEqual({ available: false })
      expect(result.errors).toContain('treasury')
    } finally { await models.moneroAccount.update({ where: { id: account.id }, data: { label: 'platform_rewards' } }) }
  })
  test('a future numeric rollout-mode entry uses its registered display unit', async () => {
    const field = FIELDS.find(field => field.key === 'postingFeeFloorPiconeros')
    const saved = field.rolloutMode
    field.rolloutMode = true
    try {
      const result = await adminOverview(models)
      expect(result.rolloutModes.find(row => row.key === field.key)).toMatchObject({ storedValue: '0.001', effectiveValue: '0.001' })
    } finally { field.rolloutMode = saved }
  })
})
