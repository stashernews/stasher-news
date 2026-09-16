/* eslint-env jest */
import { PrismaClient } from '@prisma/client'
import { onBegin } from '@/api/payIn/types/territoryUpdate'

const prisma = new PrismaClient()
const USER_PREFIX = 'occ-null-test-'

beforeAll(async () => {
  // self-heal residue from interrupted runs (mirrors rewardsDistributor.test.js):
  // user deletion cascades to its Sub, PayIn, and SubPayIn rows
  await prisma.user.deleteMany({ where: { name: { startsWith: USER_PREFIX } } })
})

afterAll(async () => {
  await prisma.user.deleteMany({ where: { name: { startsWith: USER_PREFIX } } })
  await prisma.$disconnect()
})

test('onBegin updates a sub whose billingPayInId is null (seeded/ONCE turf)', async () => {
  const [user] = await prisma.$queryRaw`INSERT INTO users (name) VALUES (${`${USER_PREFIX}${Date.now()}`}) RETURNING id::int AS id`

  const name = `occ-null-${Date.now()}`
  await prisma.sub.create({
    data: {
      name,
      userId: user.id,
      rankingType: 'WOT',
      billingType: 'ONCE',
      billingCost: 0,
      postTypes: ['LINK', 'DISCUSSION', 'JOB', 'POLL', 'BOUNTY']
    }
  })

  const payIn = await prisma.payIn.create({
    data: { userId: user.id, piconeros: 0n, payInType: 'TERRITORY_UPDATE', payInState: 'PAID' }
  })

  const updated = await onBegin(prisma, payIn.id, {
    oldName: name,
    name,
    billingType: 'ONCE',
    uploadIds: [],
    desc: 'occ test',
    postTypes: ['LINK', 'DISCUSSION', 'JOB', 'POLL', 'BOUNTY'],
    postsPiconerosFilter: 0n,
    postPremiumPiconeros: 0n,
    commentPremiumPiconeros: 0n,
    billingAutoRenew: false,
    nsfw: false
  })

  expect(updated.desc).toBe('occ test')
  expect(updated.status).toBe('ACTIVE')
})
