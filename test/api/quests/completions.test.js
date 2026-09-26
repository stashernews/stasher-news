/* eslint-env jest */
// Real-DB test for quest completion derivation (spec §4.2). Seeds actions and
// asserts each check against the day window. Cleans up after itself.
import { PrismaClient } from '@prisma/client'
import { resolveDraw } from '@/api/quests/draw'
import { completionsFor } from '@/api/quests/completions'
import { QUEST } from '@/lib/quests'

const prisma = new PrismaClient()
const DAY = '2026-01-02'
const created = { users: [], subs: [], items: [], tips: [], payIns: [], accounts: [] }

async function mkUser () {
  const [row] = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(row.id)
  return row.id
}

afterAll(async () => {
  await prisma.feeObservation.deleteMany({ where: { txHash: { startsWith: 'qtest-boost-' } } })
  await prisma.observedTip.deleteMany({ where: { txHash: { startsWith: 'qtest-' } } })
  await prisma.payIn.deleteMany({ where: { id: { in: created.payIns } } })
  await prisma.item.deleteMany({ where: { id: { in: created.items } } })
  await prisma.sub.deleteMany({ where: { id: { in: created.subs } } })
  await prisma.moneroAccount.deleteMany({ where: { id: { in: created.accounts } } })
  await prisma.user.deleteMany({ where: { id: { in: created.users } } })
  await prisma.$disconnect()
})

test('UPVOTE completes from an ObservedTip by the tipper inside the day window', async () => {
  const userId = await mkUser()
  const account = await prisma.moneroAccount.create({ data: { ownerUserId: null, address: `qtest${userId}${Date.now()}`.slice(0, 95), label: 'qtest', network: 'STAGENET', status: 'ACTIVE' } })
  created.accounts.push(account.id)
  const [post] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", title, created_at) VALUES (${userId}::int, 'qtest post', now()) RETURNING id::int AS id`
  created.items.push(post.id)
  await prisma.observedTip.create({ data: { txHash: `qtest-upvote-${Date.now()}`, postId: post.id, tipperId: userId, recipientAccountId: account.id, paymentId: `qpid-${Date.now()}`, piconeros: 100000000n, state: 'DETECTED', detectedAt: new Date(`${DAY}T12:00:00.000Z`) } })
  const draw = await resolveDraw(prisma, userId, DAY)
  const done = await completionsFor(prisma, { userId, day: DAY, draw })
  expect(done.UPVOTE).toBe(true)
})

test('FIRST_RESPONDER requires the comment to be the parent item first comment', async () => {
  const author = await mkUser()
  const replier = await mkUser()
  const [post] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", title, created_at) VALUES (${author}::int, 'qtest parent', now()) RETURNING id::int AS id`
  created.items.push(post.id)
  const [comment] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", "parentId", created_at) VALUES (${replier}::int, ${post.id}::int, ${new Date(`${DAY}T10:00:00.000Z`)}) RETURNING id::int AS id`
  created.items.push(comment.id)
  const first = await completionsFor(prisma, { userId: replier, day: DAY, draw: { upvote: QUEST.UPVOTE, drawn: QUEST.FIRST_RESPONDER } })
  expect(first.FIRST_RESPONDER).toBe(true)
  // A second commenter on the same parent fails the check.
  const second = await mkUser()
  const [comment2] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", "parentId", created_at) VALUES (${second}::int, ${post.id}::int, ${new Date(`${DAY}T11:00:00.000Z`)}) RETURNING id::int AS id`
  created.items.push(comment2.id)
  const late = await completionsFor(prisma, { userId: second, day: DAY, draw: { upvote: QUEST.UPVOTE, drawn: QUEST.FIRST_RESPONDER } })
  expect(late.FIRST_RESPONDER).toBe(false)
})

// M4 (2026-09-26 review): a BOOST payIn is born PAID with piconeros=0n the
// moment the boost dialog is opened — the real payment only exists as a
// FeeObservation (or legacy owner-leg ObservedSubFee). The completion must
// require the observation, mirroring isFeeObserved, or abandoning the QR
// completes the quest and banks a free REPLY credit.
async function seedBoostPayIn (userId, { observed }) {
  const payIn = await prisma.payIn.create({ data: { payInType: 'BOOST', userId, payInState: 'PAID', piconeros: 0n, createdAt: new Date(`${DAY}T15:00:00.000Z`) } })
  created.payIns.push(payIn.id)
  if (observed) {
    await prisma.feeObservation.create({
      data: {
        txHash: `qtest-boost-${payIn.id}-${Date.now()}`, payInId: payIn.id, feeType: 'BOOST',
        recipientMajor: 5, recipientMinor: 77, piconeros: 1_000_000_000n, state: 'DETECTED',
        detectedAt: new Date(`${DAY}T15:01:00.000Z`)
      }
    })
  }
  return payIn
}

test('BOOST completes from an observed BOOST payment inside the day window', async () => {
  const userId = await mkUser()
  await seedBoostPayIn(userId, { observed: true })
  const done = await completionsFor(prisma, { userId, day: DAY, draw: { upvote: QUEST.UPVOTE, drawn: QUEST.BOOST } })
  expect(done.BOOST).toBe(true)
})

test('BOOST does NOT complete from an initiated-but-abandoned boost (no observation)', async () => {
  const userId = await mkUser()
  await seedBoostPayIn(userId, { observed: false })
  const done = await completionsFor(prisma, { userId, day: DAY, draw: { upvote: QUEST.UPVOTE, drawn: QUEST.BOOST } })
  expect(done.BOOST).toBe(false)
})

test('TURF completes for any post or comment created in the window', async () => {
  // Rev 5: the drawn quest is just "post or comment" — no turf targeting, and
  // any item (post, comment, poll, link, bounty) counts.
  const userId = await mkUser()
  const [post] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", title, created_at) VALUES (${userId}::int, 'qtest any post', ${new Date(`${DAY}T09:00:00.000Z`)}) RETURNING id::int AS id`
  created.items.push(post.id)
  const postDone = await completionsFor(prisma, { userId, day: DAY, draw: { upvote: QUEST.UPVOTE, drawn: QUEST.TURF } })
  expect(postDone.TURF).toBe(true)

  const commenter = await mkUser()
  const [comment] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", "parentId", created_at) VALUES (${commenter}::int, ${post.id}::int, ${new Date(`${DAY}T10:00:00.000Z`)}) RETURNING id::int AS id`
  created.items.push(comment.id)
  const commentDone = await completionsFor(prisma, { userId: commenter, day: DAY, draw: { upvote: QUEST.UPVOTE, drawn: QUEST.TURF } })
  expect(commentDone.TURF).toBe(true)

  const idle = await mkUser()
  const idleDone = await completionsFor(prisma, { userId: idle, day: DAY, draw: { upvote: QUEST.UPVOTE, drawn: QUEST.TURF } })
  expect(idleDone.TURF).toBe(false)
})
