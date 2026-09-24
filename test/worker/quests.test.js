/* eslint-env jest */
import { PrismaClient } from '@prisma/client'
import { sweepQuestCompletions } from '@/worker/quests'
import { resolveDraw } from '@/api/quests/draw'
import { notifyFlameAdvanced, notifyQuestCompleted } from '@/lib/webPush'
import { utcDay, QUEST } from '@/lib/quests'

jest.mock('../../lib/webPush', () => ({
  notifyQuestCompleted: jest.fn(() => Promise.resolve()),
  notifyFlameAdvanced: jest.fn(() => Promise.resolve())
}))

const prisma = new PrismaClient()
const created = { users: [], items: [], accounts: [], tips: [] }

async function mkUser () {
  const [row] = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(row.id)
  return row.id
}

afterAll(async () => {
  await prisma.questCompletion.deleteMany({ where: { userId: { in: created.users } } })
  await prisma.observedTip.deleteMany({ where: { txHash: { startsWith: 'qsweep-' } } })
  await prisma.item.deleteMany({ where: { id: { in: created.items } } })
  await prisma.moneroAccount.deleteMany({ where: { id: { in: created.accounts } } })
  await prisma.user.deleteMany({ where: { id: { in: created.users } } })
  await prisma.$disconnect()
})

test('the sweep records each completion once and notifies once', async () => {
  const userId = await mkUser()
  // Force an upvote completion: seed a fresh tip (sweep looks back ~10 minutes).
  const account = await prisma.moneroAccount.create({ data: { ownerUserId: null, address: `qsweep${userId}${Date.now()}`.slice(0, 95), label: 'q', network: 'STAGENET', status: 'ACTIVE' } })
  created.accounts.push(account.id)
  const [post] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", title, created_at) VALUES (${userId}::int, 'qsweep post', now()) RETURNING id::int AS id`
  created.items.push(post.id)
  await prisma.observedTip.create({ data: { txHash: `qsweep-${Date.now()}`, postId: post.id, tipperId: userId, recipientAccountId: account.id, paymentId: `qsweep-pid-${Date.now()}`, piconeros: 100000000n, state: 'DETECTED' } })

  await sweepQuestCompletions({ models: prisma })
  const draw = await resolveDraw(prisma, userId, new Date().toISOString().slice(0, 10))
  const rows = await prisma.questCompletion.findMany({ where: { userId } })
  expect(rows.length).toBeGreaterThanOrEqual(1)
  expect(rows.some(r => r.quest === draw.upvote)).toBe(true)

  notifyQuestCompleted.mockClear()
  await sweepQuestCompletions({ models: prisma }) // second run: no new rows, no new pushes
  expect(notifyQuestCompleted).not.toHaveBeenCalled()
})

test('the first sweep after midnight records completions from the previous UTC day', async () => {
  const userId = await mkUser()
  // The tick at 00:02 looks back across the boundary: an action at 23:58 must
  // still be recorded for the 9th (the streak job evaluates the just-ended day).
  const now = new Date('2026-06-10T00:02:00.000Z')
  const account = await prisma.moneroAccount.create({ data: { ownerUserId: null, address: `qsweepb${userId}${Date.now()}`.slice(0, 95), label: 'q', network: 'STAGENET', status: 'ACTIVE' } })
  created.accounts.push(account.id)
  const [post] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", title, created_at) VALUES (${userId}::int, 'qsweep boundary post', now()) RETURNING id::int AS id`
  created.items.push(post.id)
  await prisma.observedTip.create({ data: { txHash: `qsweep-boundary-${Date.now()}`, postId: post.id, tipperId: userId, recipientAccountId: account.id, paymentId: `qsweep-bpid-${Date.now()}`, piconeros: 100000000n, state: 'DETECTED', detectedAt: new Date('2026-06-09T23:58:00.000Z') } })

  await sweepQuestCompletions({ models: prisma, now })

  const rows = await prisma.questCompletion.findMany({ where: { userId, day: new Date('2026-06-09T00:00:00.000Z') } })
  expect(rows.some(r => r.quest === 'UPVOTE')).toBe(true)
})

test('the sweep lights the flame as soon as a day is cleared, exactly once', async () => {
  const userId = await mkUser()
  const today = utcDay(new Date())
  const dayDate = new Date(`${today}T00:00:00.000Z`)
  // Both completions are on record (e.g. recorded by an earlier tick, or before
  // a worker restart) — the advance is driven by the rows, not the lookback.
  await prisma.questCompletion.createMany({
    data: [
      { userId, day: dayDate, quest: QUEST.UPVOTE },
      { userId, day: dayDate, quest: QUEST.BOOST }
    ]
  })

  notifyFlameAdvanced.mockClear()
  await sweepQuestCompletions({ models: prisma })
  const [user] = await prisma.$queryRaw`SELECT streak FROM users WHERE id = ${userId}::int`
  expect(user.streak).toBe(1)
  const [streak] = await prisma.streak.findMany({ where: { userId } })
  expect(streak.lastEvaluatedDay).toEqual(dayDate)
  expect(notifyFlameAdvanced.mock.calls.filter(([id]) => id === userId)).toHaveLength(1)

  // A later tick neither re-advances nor re-notifies.
  await sweepQuestCompletions({ models: prisma })
  const [after] = await prisma.$queryRaw`SELECT streak FROM users WHERE id = ${userId}::int`
  expect(after.streak).toBe(1)
  expect(notifyFlameAdvanced.mock.calls.filter(([id]) => id === userId)).toHaveLength(1)
})
