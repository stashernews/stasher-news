/* eslint-env jest */

// Real-DB end-to-end tests for the quest-system quotas (spec
// 2026-09-23-daily-quests): getInitial must treat today's quest completions,
// the flame day-3 bonus, and banked/expired StreakReward POST rows exactly as
// the quota helpers compute them.

import { PrismaClient } from '@prisma/client'
import { getInitial } from '@/api/payIn/types/itemCreate'
import { moneroUriAmountPiconeros } from '@/lib/format'

jest.mock('../../lib/lexical/server/mentions', () => ({
  __esModule: true,
  extractMentions: () => ({ userNames: [], itemIds: [] })
}))
jest.mock('../../api/resolvers/item', () => ({ __esModule: true, getItem: jest.fn() }))
jest.mock('../../api/monero/feePool', () => ({
  __esModule: true,
  reserveFeeSubaddress: jest.fn(async () => ({ id: 1, major: 1, minor: 1, address: 'A'.repeat(95) }))
}))

const prisma = new PrismaClient()
const DAY = 86_400_000
const created = { users: [], items: [], accounts: [], tips: [] }

async function createUser () {
  const [row] = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(row.id)
  return row.id
}

// A DETECTED tip by this user today completes the upvote quest.
async function seedRecentTip (tipperId) {
  const [post] = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", title, "created_at") VALUES (${tipperId}::int, ${'quest e2e tip post'}, now()) RETURNING id::int AS id`
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(post.id)}::ltree WHERE id = ${post.id}::int`
  created.items.push(post.id)
  const account = await prisma.moneroAccount.create({
    data: { ownerUserId: null, address: `5Bqtest${tipperId}${Date.now()}`.slice(0, 95), label: 'test', network: 'STAGENET', status: 'ACTIVE' }
  })
  created.accounts.push(account.id)
  const tip = await prisma.observedTip.create({
    data: {
      txHash: `questse2e-${tipperId}-${Date.now()}-${created.tips.length}`,
      postId: post.id,
      tipperId,
      recipientAccountId: account.id,
      paymentId: `pid-${tipperId}-${Date.now()}-${created.tips.length}`,
      piconeros: 100000000n,
      state: 'DETECTED'
    }
  })
  created.tips.push(String(tip.id))
  return tip
}

async function seedReward (userId, { type = 'POST', expiresAt }) {
  return prisma.streakReward.create({
    data: { userId, type, expiresAt, grantedAt: new Date(Date.now() - DAY) }
  })
}

afterAll(async () => {
  await prisma.observedTip.deleteMany({ where: { txHash: { startsWith: 'questse2e-' } } })
  for (const id of created.items) {
    await prisma.itemUserAgg.deleteMany({ where: { itemId: id } })
    await prisma.item.deleteMany({ where: { id } })
  }
  for (const id of created.accounts) await prisma.moneroAccount.deleteMany({ where: { id } })
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } })
  await prisma.$disconnect()
})

async function ensureFeeConfig () {
  if (!await prisma.platformFeeConfig.findUnique({ where: { id: 1 } })) {
    await prisma.platformFeeConfig.create({ data: { id: 1 } })
  }
}

test('the upvote quest extends the daily reply quota past the used base', async () => {
  await ensureFeeConfig()
  const userId = await createUser()
  // low-rep base is 1 and already used today
  await prisma.$executeRaw`UPDATE users SET "freeCommentCount" = 1 WHERE id = ${userId}::int`
  await seedRecentTip(userId)
  const result = await getInitial(prisma, { parentId: '999999' }, { me: { id: userId } })
  expect(result).toEqual({ payInType: 'ITEM_CREATE', userId, piconeros: 0n })
})

test('the flame day-3 bonus extends the daily reply quota past the used base', async () => {
  const userId = await createUser()
  await prisma.$executeRaw`UPDATE users SET "freeCommentCount" = 1, streak = 3 WHERE id = ${userId}::int`
  const result = await getInitial(prisma, { parentId: '999999' }, { me: { id: userId } })
  expect(result).toEqual({ payInType: 'ITEM_CREATE', userId, piconeros: 0n })
})

test('with the base used and no completions, the comment fee returns', async () => {
  const userId = await createUser()
  await prisma.$executeRaw`UPDATE users SET "freeCommentCount" = 1 WHERE id = ${userId}::int`
  const result = await getInitial(prisma, { parentId: '999999' }, { me: { id: userId } })
  expect(result.moneroUri).toMatch(/^monero:/)
  expect(moneroUriAmountPiconeros(result.moneroUri)).toBe(600_000_000n)
})

test('a banked POST reward keeps a post free past the exhausted monthly base; an expired one does not', async () => {
  const userId = await createUser()
  await prisma.$executeRaw`
    UPDATE users SET "stackedPiconeros" = 10000000000, "created_at" = now() - interval '8 days', "freePostCount" = 5
    WHERE id = ${userId}::int`
  await seedReward(userId, { expiresAt: new Date(Date.now() + 20 * DAY) })
  const free = await getInitial(prisma, {}, { me: { id: userId } })
  expect(free).toEqual({ payInType: 'ITEM_CREATE', userId, piconeros: 0n })

  const other = await createUser()
  await prisma.$executeRaw`
    UPDATE users SET "stackedPiconeros" = 10000000000, "created_at" = now() - interval '8 days', "freePostCount" = 5
    WHERE id = ${other}::int`
  await seedReward(other, { expiresAt: new Date(Date.now() - DAY) }) // already expired
  const paid = await getInitial(prisma, {}, { me: { id: other } })
  expect(paid.moneroUri).toMatch(/^monero:/)
  expect(paid.moneroUri).toContain('tx_amount=0.001')
})
