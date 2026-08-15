/* eslint-env jest */

// Integration tests for fee-pool top-up decision + orchestration (spec §5.6).
//
// feePoolLevels is exercised against the live DB with an explicit accountId.
// topUpFeePoolIfLow receives an injectable `derive` mock so the orchestration
// (threshold check, batch target computation, per-major dispatch, in-progress
// guard) is tested without monero-ts or the network. The real extendFeePool is
// covered indirectly by the manual script (Task 2) and is a monero-ts
// integration concern, not unit-tested here.

import { PrismaClient } from '@prisma/client'
import { feePoolLevels, topUpFeePoolIfLow, FEE_POOL_TOPUP_THRESHOLD } from '@/api/monero/feePoolDerive'
import { sweepFakeRewardsWallets } from '../helpers/sweepRewardsWallets'

const prisma = new PrismaClient()

const REWARDS_ADDR = '5RpnlTopUp' + 'A'.repeat(88) // unique stagenet placeholder

let walletId

beforeAll(async () => {
  await sweepFakeRewardsWallets([REWARDS_ADDR])
  const acct = await prisma.moneroAccount.create({
    data: { ownerUserId: null, address: REWARDS_ADDR, label: 'platform_rewards', network: 'STAGENET', status: 'ACTIVE' }
  })
  walletId = acct.id
  process.env.POSTING_FEE_POOL_SIZE = '2000'
  process.env.TERRITORY_FEE_POOL_SIZE = '200'
})

afterEach(async () => {
  await prisma.subaddressIndex.deleteMany({ where: { accountId: walletId } })
  process.env.POSTING_FEE_POOL_SIZE = '2000'
  process.env.TERRITORY_FEE_POOL_SIZE = '200'
})

afterAll(async () => {
  await prisma.subaddressIndex.deleteMany({ where: { accountId: walletId } })
  await prisma.moneroAccount.deleteMany({ where: { id: walletId } })
  await sweepFakeRewardsWallets([REWARDS_ADDR])
  await prisma.$disconnect()
})

async function seedSubs (major, minors) {
  for (const minor of minors) {
    await prisma.subaddressIndex.create({
      data: { accountId: walletId, majorIndex: major, minorIndex: minor, address: `pool-${major}-${minor}`, state: 'AVAILABLE' }
    })
  }
}

test('FEE_POOL_TOPUP_THRESHOLD defaults to 100', () => {
  expect(FEE_POOL_TOPUP_THRESHOLD).toBe(100)
})

test('feePoolLevels reports available/total/maxMinor per major', async () => {
  await seedSubs(1, [1, 2, 3])
  await seedSubs(2, [1])
  const levels = await feePoolLevels(prisma, walletId)
  expect(levels[1]).toEqual({ available: 3, total: 3, maxMinor: 3 })
  expect(levels[2]).toEqual({ available: 1, total: 1, maxMinor: 1 })
})

test('topUpFeePoolIfLow extends a low major to maxMinor + batch; leaves a healthy major alone', async () => {
  await seedSubs(1, [1, 2, 3]) // AVAILABLE 3 < 100
  await seedSubs(2, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
    31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
    41, 42, 43, 44, 45, 46, 47, 48, 49, 50,
    51, 52, 53, 54, 55, 56, 57, 58, 59, 60,
    61, 62, 63, 64, 65, 66, 67, 68, 69, 70,
    71, 72, 73, 74, 75, 76, 77, 78, 79, 80,
    81, 82, 83, 84, 85, 86, 87, 88, 89, 90,
    91, 92, 93, 94, 95, 96, 97, 98, 99, 100,
    101, 102, 103, 104, 105, 106, 107, 108, 109, 110,
    111, 112, 113, 114, 115, 116, 117, 118, 119, 120,
    121, 122, 123, 124, 125, 126, 127, 128, 129, 130,
    131, 132, 133, 134, 135, 136, 137, 138, 139, 140,
    141, 142, 143, 144, 145, 146, 147, 148, 149, 150]) // AVAILABLE 150 >= 100
  await seedSubs(3, Array.from({ length: 150 }, (_, i) => i + 1)) // healthy donate
  await seedSubs(4, Array.from({ length: 150 }, (_, i) => i + 1)) // healthy tip-unwalleted
  await seedSubs(5, Array.from({ length: 150 }, (_, i) => i + 1)) // healthy boost
  const derive = jest.fn(async ({ account, major, targetMinor }) => 7)
  const result = await topUpFeePoolIfLow(prisma, { threshold: 100, account: { id: walletId }, derive })

  expect(derive).toHaveBeenCalledTimes(1)
  expect(derive).toHaveBeenCalledWith(expect.objectContaining({ account: { id: walletId }, major: 1, targetMinor: 3 + 2000 }))
  expect(result.topUps).toEqual([{ major: 1, targetMinor: 2003, added: 7 }])
})

test('topUpFeePoolIfLow does nothing when all fee majors are healthy', async () => {
  await seedSubs(1, Array.from({ length: 150 }, (_, i) => i + 1))
  await seedSubs(2, Array.from({ length: 150 }, (_, i) => i + 1))
  await seedSubs(3, Array.from({ length: 150 }, (_, i) => i + 1)) // healthy donate
  await seedSubs(4, Array.from({ length: 150 }, (_, i) => i + 1)) // healthy tip-unwalleted
  await seedSubs(5, Array.from({ length: 150 }, (_, i) => i + 1)) // healthy boost
  const derive = jest.fn(async () => 7)
  const result = await topUpFeePoolIfLow(prisma, { threshold: 100, account: { id: walletId }, derive })
  expect(derive).not.toHaveBeenCalled()
  expect(result.topUps).toEqual([])
})

test('topUpFeePoolIfLow derives an empty territory pool too (available 0 < threshold)', async () => {
  await seedSubs(1, Array.from({ length: 150 }, (_, i) => i + 1)) // healthy posting
  await seedSubs(3, Array.from({ length: 150 }, (_, i) => i + 1)) // healthy donate
  await seedSubs(4, Array.from({ length: 150 }, (_, i) => i + 1)) // healthy tip-unwalleted
  await seedSubs(5, Array.from({ length: 150 }, (_, i) => i + 1)) // healthy boost
  const derive = jest.fn(async () => 9)
  const result = await topUpFeePoolIfLow(prisma, { threshold: 100, account: { id: walletId }, derive })
  expect(derive).toHaveBeenCalledTimes(1)
  expect(derive).toHaveBeenCalledWith(expect.objectContaining({ major: 2, targetMinor: 0 + 200 }))
  expect(result.topUps).toEqual([{ major: 2, targetMinor: 200, added: 9 }])
})

test('topUpFeePoolIfLow skips while a previous top-up is still in progress', async () => {
  await seedSubs(1, [1, 2, 3])
  await seedSubs(2, Array.from({ length: 150 }, (_, i) => i + 1)) // healthy, keeps derive at exactly one call
  await seedSubs(3, Array.from({ length: 150 }, (_, i) => i + 1)) // healthy donate
  await seedSubs(4, Array.from({ length: 150 }, (_, i) => i + 1)) // healthy tip-unwalleted
  await seedSubs(5, Array.from({ length: 150 }, (_, i) => i + 1)) // healthy boost
  let release
  const gate = new Promise(resolve => { release = resolve })
  const derive = jest.fn(() => gate)
  const first = topUpFeePoolIfLow(prisma, { threshold: 100, account: { id: walletId }, derive })
  await new Promise(resolve => setImmediate(resolve))
  const second = await topUpFeePoolIfLow(prisma, { threshold: 100, account: { id: walletId }, derive })
  expect(second.skipped).toBe('in-progress')
  release()
  await first
  expect(derive).toHaveBeenCalledTimes(1)
})

test('topUpFeePoolIfLow with no registered account resolves { skipped: "no-account" }', async () => {
  // Inject a models stub whose account lookup returns null (passing a real
  // account: null would trigger the real findFirst and find account id=2).
  const models = { moneroAccount: { findFirst: jest.fn().mockResolvedValue(null) } }
  const derive = jest.fn(async () => 7)
  const result = await topUpFeePoolIfLow(models, { threshold: 100, derive })
  expect(result.skipped).toBe('no-account')
  expect(derive).not.toHaveBeenCalled()
  expect(models.moneroAccount.findFirst).toHaveBeenCalled()
})
