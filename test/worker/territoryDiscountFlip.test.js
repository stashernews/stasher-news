/* eslint-env jest */
import { PrismaClient } from '@prisma/client'
import { flipPendingToLive } from '@/worker/rewardsWalletObserver'

const prisma = new PrismaClient()
const DAY = 86_400_000
const created = { users: [], subs: [], payIns: [] }

async function mkUser () {
  const [row] = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(row.id)
  return row.id
}

afterAll(async () => {
  await prisma.sub.deleteMany({ where: { id: { in: created.subs } } })
  await prisma.payIn.deleteMany({ where: { id: { in: created.payIns } } })
  await prisma.streakReward.deleteMany({ where: { userId: { in: created.users } } })
  await prisma.user.deleteMany({ where: { id: { in: created.users } } })
  await prisma.$disconnect()
})

// Spec §5: the day-7 discount is consumed only on a successful creation, so it
// is spent at the fee FLIP (payment observed), not when the payIn is created.
test('a territory fee flip consumes exactly one held TURF_DISCOUNT', async () => {
  const userId = await mkUser()
  const payIn = await prisma.payIn.create({ data: { payInType: 'TERRITORY_CREATE', userId, payInState: 'PAID', piconeros: 0n } })
  created.payIns.push(payIn.id)
  const sub = await prisma.sub.create({
    data: {
      name: `qdiscount-${Date.now()}`,
      userId,
      rankingType: 'RECENT',
      billingType: 'MONTHLY',
      billingCost: 0,
      billingStatus: 'PENDING_FEE',
      billingPayInId: payIn.id
    }
  })
  created.subs.push(sub.id)
  // Two seeded rows prove the flip consumption happens once per flip even when
  // a stray extra row exists (real grants never stack, but the probe is safe).
  await prisma.streakReward.create({ data: { userId, type: 'TURF_DISCOUNT', grantedAt: new Date(), expiresAt: new Date(Date.now() + DAY) } })
  await prisma.streakReward.create({ data: { userId, type: 'TURF_DISCOUNT', grantedAt: new Date(), expiresAt: new Date(Date.now() + DAY) } })

  await flipPendingToLive(prisma, payIn, 20_000_000_000n)
  const flipped = await prisma.sub.findUnique({ where: { id: sub.id } })
  expect(flipped.billingStatus).toBe('PAID')
  const consumedAfterFirst = await prisma.streakReward.count({ where: { userId, type: 'TURF_DISCOUNT', consumedAt: { not: null } } })
  expect(consumedAfterFirst).toBe(1)

  // A re-poll of an already-PAID sub must not consume another row.
  await flipPendingToLive(prisma, payIn, 20_000_000_000n)
  const consumedAfterSecond = await prisma.streakReward.count({ where: { userId, type: 'TURF_DISCOUNT', consumedAt: { not: null } } })
  expect(consumedAfterSecond).toBe(1)
})
