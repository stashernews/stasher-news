/* eslint-env jest */

// Integration tests for the rewards-wallet fee subaddress pool (spec §5.6, §6.2).
//
// reserveFeeSubaddress atomically draws (FOR UPDATE SKIP LOCKED) the lowest-id
// AVAILABLE SubaddressIndex on the platform_rewards wallet for a fee type's major
// index (1 = posting, 2 = territory) and marks it ASSIGNED. These tests run
// against the live, migrated database.

import { PrismaClient } from '@prisma/client'
import { reserveFeeSubaddress, getRewardsWalletId, REWARDS_POSTING_MAJOR, REWARDS_TERRITORY_MAJOR } from '@/api/monero/feePool'
import { sweepFakeRewardsWallets } from '../../helpers/sweepRewardsWallets'

process.env.MONERO_NETWORK = 'stagenet'

const prisma = new PrismaClient()

// one platform_rewards wallet per test file (isolated jest worker). Unique address
// avoids the @@unique([address, network]) collision with any other test's wallet.
const REWARDS_ADDR = '5BJd3FfMuvWeePRNT192gwa9m63XHdzBmMxfizUhBJedJSqA1Y1BViTETV6uxyCS8Zf8Tz2KKEhHC8FjSRvuDgsd2JuAX6Zf'

let rewardsWalletId
const seededIds = []

async function seedPool ({ major, count, startMinor = 1 }) {
  for (let minor = startMinor; minor < startMinor + count; minor++) {
    const row = await prisma.subaddressIndex.create({
      data: {
        accountId: rewardsWalletId,
        majorIndex: major,
        minorIndex: minor,
        // opaque address — the draw logic does not validate address content
        address: `pool-${major}-${minor}-${rewardsWalletId}`,
        state: 'AVAILABLE'
      }
    })
    seededIds.push(row.id)
  }
}

beforeAll(async () => {
  await sweepFakeRewardsWallets([REWARDS_ADDR])

  // getRewardsWalletId resolves the platform_rewards wallet via a bare
  // findFirst (lowest id in practice). The dev DB may already hold the real
  // registered wallet (or another suite's row), so insert this suite's row
  // with an id far below any existing account — mirroring monero.test.js's
  // createRewardsWallet trick — for deterministic resolution. The -1000
  // offset keeps us clear of monero.test.js's transient lowest-1 rows when
  // both suites run in parallel jest workers.
  const lowest = await prisma.moneroAccount.findFirst({ orderBy: { id: 'asc' } })
  const acct = await prisma.moneroAccount.create({
    data: {
      id: lowest ? lowest.id - 1000 : undefined,
      label: 'platform_rewards',
      address: REWARDS_ADDR,
      network: 'STAGENET',
      status: 'ACTIVE'
    }
  })
  rewardsWalletId = acct.id
})

afterEach(async () => {
  if (seededIds.length) {
    await prisma.subaddressIndex.deleteMany({ where: { id: { in: seededIds } } })
    seededIds.length = 0
  }
})

afterAll(async () => {
  await prisma.subaddressIndex.deleteMany({ where: { accountId: rewardsWalletId } })
  await prisma.moneroAccount.delete({ where: { id: rewardsWalletId } })
  await sweepFakeRewardsWallets([REWARDS_ADDR])
  await prisma.$disconnect()
})

test('getRewardsWalletId resolves the platform_rewards wallet', async () => {
  expect(await getRewardsWalletId(prisma)).toBe(rewardsWalletId)
})

test('reserveFeeSubaddress draws an AVAILABLE posting-fee subaddress and marks it ASSIGNED', async () => {
  await seedPool({ major: REWARDS_POSTING_MAJOR, count: 3 })
  const sub = await reserveFeeSubaddress(prisma, 'POSTING')
  expect(sub.major).toBe(REWARDS_POSTING_MAJOR)
  expect(sub.address).toBeTruthy()
  // lowest-id AVAILABLE row is drawn first (minor 1)
  expect(sub.minor).toBe(1)
  const row = await prisma.subaddressIndex.findUnique({ where: { id: sub.id } })
  expect(row.state).toBe('ASSIGNED')
})

test('reserveFeeSubaddress returns the right major per fee type', async () => {
  await seedPool({ major: REWARDS_POSTING_MAJOR, count: 1 })
  await seedPool({ major: REWARDS_TERRITORY_MAJOR, count: 2 })
  expect((await reserveFeeSubaddress(prisma, 'TERRITORY_CREATE')).major).toBe(REWARDS_TERRITORY_MAJOR)
  expect((await reserveFeeSubaddress(prisma, 'TERRITORY_BILLING')).major).toBe(REWARDS_TERRITORY_MAJOR)
  expect((await reserveFeeSubaddress(prisma, 'POSTING')).major).toBe(REWARDS_POSTING_MAJOR)
})

test('reserveFeeSubaddress draws distinct subaddresses on repeated calls', async () => {
  await seedPool({ major: REWARDS_POSTING_MAJOR, count: 3 })
  const a = await reserveFeeSubaddress(prisma, 'POSTING')
  const b = await reserveFeeSubaddress(prisma, 'POSTING')
  expect(a.id).not.toBe(b.id)
})

test('reserveFeeSubaddress throws when the pool is exhausted', async () => {
  await expect(reserveFeeSubaddress(prisma, 'POSTING')).rejects.toThrow(/exhausted|pool/)
})

test('reserveFeeSubaddress rejects an unknown fee type', async () => {
  await expect(reserveFeeSubaddress(prisma, 'BOGUS')).rejects.toThrow(/unknown feeType/)
})
