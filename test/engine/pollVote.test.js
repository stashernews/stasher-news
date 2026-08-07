/* eslint-env jest */

// POLL_VOTE free-vote regression (A-08 Task 5). The fork removed poll-vote
// founder revenue, so a poll vote must be free: getInitial returns piconeros 0n
// and the payIn engine marks it PAID at creation (mCostRemaining 0n → PAID),
// after which onBegin records + anonymizes the PollVote row.
//
// Before the fix getInitial set piconeros = pollCost × 1000n with no moneroUri,
// so every vote with pollCost > 0 landed in PENDING_INVOICE_CREATION and
// afterBegin threw "Monero payments not implemented".
//
// Real-DB integration test (drives the actual pay() entry point against the
// migrated dev database), mirroring test/engine/payInItemCreate.test.js.

import pay from '@/api/payIn'
import { PrismaClient } from '@prisma/client'

// The POLL_VOTE path imports the full payIn type barrel via api/payIn/lib/is,
// which pulls in itemCreate → @/lib/lexical/server/mentions (ESM-only
// mdast-util-from-markdown, not transformed by next/jest) and
// @/api/resolvers/item (heavy lexical/html chain). Neither is exercised by the
// POLL_VOTE flow, so both are stubbed — same technique as
// test/engine/payInItemCreate.test.js. (babel-jest hoists these jest.mock
// calls above the imports at runtime.)
jest.mock('../../lib/lexical/server/mentions', () => ({
  __esModule: true,
  extractMentions: () => ({ userNames: [], itemIds: [] })
}))
jest.mock('../../api/resolvers/item', () => ({
  __esModule: true,
  getItem: jest.fn()
}))

const prisma = new PrismaClient()

// FK-safe teardown. PollVote + PollOption cascade from Item; ItemPayIn + the
// pgboss.checkStreak job (queued by onPaid) cascade / are isolated from PayIn.
// We track only the parents (users, items, payIns).
const created = { users: [], items: [], payIns: [] }

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  const id = rows[0].id
  created.users.push(id)
  return id
}

// Seed a root poll post (parentId null) with pollCost > 0 so the PRE-FIX code
// computes piconeros > 0 and trips the "Monero payments not implemented" throw.
// path is set via a second statement (ltree is unsupported by Prisma create).
async function createPollItem (userId) {
  const rows = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", title, "pollCost", "created_at")
    VALUES (${userId}::int, ${'poll vote regression post'}, ${1}::int, now())
    RETURNING id::int AS id`
  const id = rows[0].id
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(id)}::ltree WHERE id = ${id}::int`
  created.items.push(id)
  return id
}

async function createPollOption (itemId, option) {
  const rows = await prisma.$queryRaw`
    INSERT INTO "PollOption" ("itemId", option, "created_at", "updated_at")
    VALUES (${itemId}::int, ${option}, now(), now())
    RETURNING id::int AS id`
  return rows[0].id
}

afterAll(async () => {
  for (const id of created.items) {
    await prisma.item.deleteMany({ where: { id } }).catch(() => {})
  }
  await prisma.payIn.deleteMany({ where: { id: { in: created.payIns } } }).catch(() => {})
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } }).catch(() => {})
  await prisma.$disconnect()
})

test('POLL_VOTE is free: pay() returns a PAID payIn and records the PollVote', async () => {
  const userId = await createUser()
  const itemId = await createPollItem(userId)
  const optionId = await createPollOption(itemId, 'yes')

  const result = await pay('POLL_VOTE', { id: String(optionId) }, { me: { id: userId } })

  // pay() returns { ...payIn, result: { ...result, payIn } } when PAID
  expect(result.payInState).toBe('PAID')
  created.payIns.push(result.id)

  // onBegin creates the PollVote row then anonymizes it (payInId → null)
  const vote = await prisma.pollVote.findFirst({
    where: { pollOptionId: optionId, itemId },
    orderBy: { id: 'desc' }
  })
  expect(vote).toBeTruthy()
  expect(vote.payInId).toBeNull()
})
