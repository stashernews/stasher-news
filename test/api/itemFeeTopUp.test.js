/* eslint-env jest */
import prisma from '@/api/models'
import resolver from '@/api/resolvers/item'
import { moneroUriAddress, moneroUriAmountPiconeros } from '@/lib/format'

// item.js statically imports @/lib/lexical/server/mentions (ESM-only
// mdast-util-from-markdown) via the payIn engine, and @/lib/lexical/server/html
// (ESM-only github-slugger via the headless editor); feeTopUpUri exercises
// neither, so stub both like test/api/bountyFunding.test.js. jest.mock is
// hoisted above the imports.
jest.mock('../../lib/lexical/server/mentions', () => ({
  __esModule: true,
  extractMentions: () => ({ userNames: [], itemIds: [] })
}))
jest.mock('../../lib/lexical/server/html', () => ({
  __esModule: true,
  lexicalHTMLGenerator: () => ({ html: '', text: '' })
}))

process.env.MONERO_NETWORK = 'stagenet'

const ADDR = '5' + 'F'.repeat(94)
const FEE_URI = (xmr) => `monero:${ADDR}?tx_amount=${xmr}`

const created = { users: [], items: [], payIns: [], fees: [] }

afterAll(async () => {
  await prisma.feeObservation.deleteMany({ where: { id: { in: created.fees } } })
  await prisma.item.deleteMany({ where: { id: { in: created.items } } })
  await prisma.payIn.deleteMany({ where: { id: { in: created.payIns } } })
  await prisma.user.deleteMany({ where: { id: { in: created.users } } })
  await prisma.$disconnect()
})

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  const id = rows[0].id
  created.users.push(id)
  return id
}

// A PENDING_FEE item with a fee PayIn carrying the FULL-fee URI + a reserved
// subaddress (major 2 / minor N) and one partial FeeObservation.
async function seedPendingFeeItem ({ receivedPiconeros = 0n } = {}) {
  const userId = await createUser()
  const payIn = await prisma.payIn.create({
    data: {
      userId,
      payInType: 'ITEM_CREATE',
      payInState: 'PAID',
      piconeros: 0n,
      moneroUri: FEE_URI('0.001'),
      moneroSubaddressMajor: 2,
      moneroSubaddressMinor: 7
    }
  })
  created.payIns.push(payIn.id)
  const item = await prisma.item.create({
    data: {
      userId,
      title: 'test post',
      status: 'ACTIVE',
      feeStatus: 'PENDING_FEE',
      feePayInId: payIn.id
    }
  })
  created.items.push(item.id)
  if (receivedPiconeros > 0n) {
    const fee = await prisma.feeObservation.create({
      data: {
        txHash: 'itop-' + payIn.id,
        payInId: payIn.id,
        feeType: 'POSTING',
        postId: item.id,
        recipientMajor: 2,
        recipientMinor: 7,
        piconeros: receivedPiconeros,
        state: 'DETECTED'
      }
    })
    created.fees.push(fee.id)
  }
  return { userId, item, payIn }
}

describe('Item.feeTopUpUri', () => {
  test('re-entry after a partial re-quotes only the REMAINDER on the SAME subaddress', async () => {
    const { userId, item } = await seedPendingFeeItem({ receivedPiconeros: 400_000_000n }) // 0.4 of 1.0
    const res = await resolver.Item.feeTopUpUri(item, null, { models: prisma, me: { id: userId } })
    expect(moneroUriAddress(res)).toBe(ADDR)
    expect(moneroUriAmountPiconeros(res)).toBe(600_000_000n) // 1.0 - 0.4 remainder
  })

  test('nothing received yet -> full fee', async () => {
    const { userId, item } = await seedPendingFeeItem()
    const res = await resolver.Item.feeTopUpUri(item, null, { models: prisma, me: { id: userId } })
    expect(moneroUriAmountPiconeros(res)).toBe(1_000_000_000n)
  })

  test('a fully-covered payIn re-quotes the full fee (hint would be null)', async () => {
    const { userId, item } = await seedPendingFeeItem({ receivedPiconeros: 1_000_000_000n })
    const res = await resolver.Item.feeTopUpUri(item, null, { models: prisma, me: { id: userId } })
    expect(moneroUriAmountPiconeros(res)).toBe(1_000_000_000n)
  })

  test('null for a non-PENDING_FEE item', async () => {
    const { userId, item } = await seedPendingFeeItem()
    const res = await resolver.Item.feeTopUpUri({ ...item, feeStatus: 'FEE_PAID' }, null, { models: prisma, me: { id: userId } })
    expect(res).toBeNull()
  })

  test('null when there is no fee PayIn', async () => {
    const { userId, item } = await seedPendingFeeItem()
    const res = await resolver.Item.feeTopUpUri({ ...item, feePayInId: null }, null, { models: prisma, me: { id: userId } })
    expect(res).toBeNull()
  })

  test('the stored full-fee URI is NEVER rewritten', async () => {
    const { userId, item, payIn } = await seedPendingFeeItem({ receivedPiconeros: 400_000_000n })
    await resolver.Item.feeTopUpUri(item, null, { models: prisma, me: { id: userId } })
    const afterPayIn = await prisma.payIn.findUnique({ where: { id: payIn.id } })
    expect(afterPayIn.moneroUri).toBe(FEE_URI('0.001'))
  })

  test('null for an anonymous viewer', async () => {
    const { item } = await seedPendingFeeItem({ receivedPiconeros: 400_000_000n })
    const res = await resolver.Item.feeTopUpUri(item, null, { models: prisma })
    expect(res).toBeNull()
  })

  test('null for a non-owner viewer', async () => {
    const { item } = await seedPendingFeeItem({ receivedPiconeros: 400_000_000n })
    const stranger = await createUser()
    const res = await resolver.Item.feeTopUpUri(item, null, { models: prisma, me: { id: stranger } })
    expect(res).toBeNull()
  })
})
