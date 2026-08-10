/* eslint-env jest */

// Integration test for the referrals resolver (A-09 Task 3): FOREVER_REFERRAL
// Earn rows (written weekly by rewardsDistributor) bucketed per UTC day, for
// the caller only. Real dev DB, fixtures tracked + removed (mirrors
// test/api/resolvers/growth.test.js).

import { PrismaClient } from '@prisma/client'
import referralsResolver from '@/api/resolvers/referrals'

const prisma = new PrismaClient()
const created = { users: [], earns: [] }

const DAY = 24 * 60 * 60 * 1000

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(rows[0].id)
  return rows[0].id
}

async function createEarn (userId, piconeros, createdAt, distributionId = null) {
  const row = await prisma.earn.create({
    data: { userId, piconeros, type: 'FOREVER_REFERRAL', rank: null, typeId: null, distributionId, createdAt }
  })
  created.earns.push(row.id)
}

afterAll(async () => {
  await prisma.earn.deleteMany({ where: { id: { in: created.earns } } })
  await prisma.user.deleteMany({ where: { id: { in: created.users } } })
  await prisma.$disconnect()
})

test('referrals returns per-day FOREVER_REFERRAL totals for me', async () => {
  const me = await createUser()
  const yesterday = new Date(Date.now() - DAY)
  await createEarn(me, 1_000_000_000n, yesterday)
  await createEarn(me, 500_000_000n, new Date())
  const other = await createUser()
  await createEarn(other, 9_000_000_000n, new Date()) // not mine — excluded

  const result = await referralsResolver.Query.referrals(null,
    { when: 'custom', from: String(Date.now() - 2 * DAY), to: String(Date.now() + DAY) },
    { me: { id: me }, models: prisma })

  expect(result.length).toBeGreaterThanOrEqual(2)
  const total = result.reduce((acc, r) => acc + (r.data.find(d => d.name === 'referral piconeros')?.value ?? 0n), 0n)
  expect(total).toBe(1_500_000_000n)
})
