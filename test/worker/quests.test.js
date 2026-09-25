/* eslint-env jest */
import { PrismaClient } from '@prisma/client'
import { sweepQuestCompletions } from '@/worker/quests'
import { resolveDraw } from '@/api/quests/draw'
import { notifyFlameAdvanced, notifyQuestCompleted } from '@/lib/webPush'
import { drawFor, utcDay, QUEST } from '@/lib/quests'

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
  await prisma.streakReward.deleteMany({ where: { userId: { in: created.users } } })
  await prisma.questCompletion.deleteMany({ where: { userId: { in: created.users } } })
  await prisma.observedTip.deleteMany({ where: { txHash: { startsWith: 'qsweep-' } } })
  await prisma.payIn.deleteMany({ where: { userId: { in: created.users } } })
  await prisma.item.deleteMany({ where: { id: { in: created.items } } })
  await prisma.moneroAccount.deleteMany({ where: { id: { in: created.accounts } } })
  await prisma.streak.deleteMany({ where: { userId: { in: created.users } } })
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

test('a run\'s first day banks the day 1 rung plus both quest credits', async () => {
  const userId = await mkUser()
  // No streak rows and no prior completions: today is the run's first day, so
  // no active FLAME row exists until the sweep's own advance creates it.
  // Pick a day whose drawn slot is BOOST so both quests are tip/payIn-driven.
  let day = null
  for (let i = 0; i < 30 && !day; i++) {
    const d = utcDay(new Date(Date.now() + i * 86_400_000))
    if (drawFor(userId, d).drawn === QUEST.BOOST) day = d
  }
  expect(day).not.toBeNull()
  const now = new Date(`${day}T12:00:00.000Z`)
  const account = await prisma.moneroAccount.create({ data: { ownerUserId: null, address: `qsweepd${userId}${Date.now()}`.slice(0, 95), label: 'q', network: 'STAGENET', status: 'ACTIVE' } })
  created.accounts.push(account.id)
  const [post] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", title, created_at) VALUES (${userId}::int, 'qsweep first-day post', now()) RETURNING id::int AS id`
  created.items.push(post.id)
  await prisma.observedTip.create({ data: { txHash: `qsweep-firstday-${Date.now()}`, postId: post.id, tipperId: userId, recipientAccountId: account.id, paymentId: `qsweep-fd-pid-${Date.now()}`, piconeros: 100000000n, state: 'DETECTED', detectedAt: new Date(now.getTime() - 5 * 60 * 1000) } })
  await prisma.payIn.create({ data: { userId, payInType: 'BOOST', payInState: 'PAID', piconeros: 100000000n, createdAt: new Date(now.getTime() - 4 * 60 * 1000) } })

  await sweepQuestCompletions({ models: prisma, now })

  expect(await prisma.questCompletion.count({ where: { userId, day: new Date(`${day}T00:00:00.000Z`) } })).toBe(2)
  // The advance created the run on this first cleared day.
  const [streak] = await prisma.streak.findMany({ where: { userId, type: 'FLAME' } })
  expect(streak).toBeDefined()
  expect(streak.startedAt).toEqual(new Date(`${day}T00:00:00.000Z`))
  expect(streak.lastEvaluatedDay).toEqual(new Date(`${day}T00:00:00.000Z`))
  const [user] = await prisma.$queryRaw`SELECT streak FROM users WHERE id = ${userId}::int`
  expect(user.streak).toBe(1)
  // Day 1's rung banks a reply too (rev 4), on top of one credit per quest:
  // three total, tied to the run the advance just created.
  const credits = await prisma.streakReward.findMany({ where: { userId, type: 'REPLY' } })
  expect(credits).toHaveLength(3)
  expect(credits.every(c => c.streakId === streak.id && c.consumedAt === null)).toBe(true)

  await sweepQuestCompletions({ models: prisma, now }) // re-run: nothing new banks
  expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY' } })).toBe(3)
})

test('recording a completion banks one reply credit, once', async () => {
  const userId = await mkUser()
  // An active flame whose previous day is still pending: the sweep's advance
  // defers, so every credit below comes from the per-quest banking.
  await prisma.streak.create({ data: { userId, type: 'FLAME', startedAt: new Date(Date.now() - 86_400_000) } })
  // Pick a day whose drawn slot is BOOST so both quests are tip/payIn-driven.
  let day = null
  for (let i = 0; i < 30 && !day; i++) {
    const d = utcDay(new Date(Date.now() + i * 86_400_000))
    if (drawFor(userId, d).drawn === QUEST.BOOST) day = d
  }
  expect(day).not.toBeNull()
  const now = new Date(`${day}T12:00:00.000Z`)
  const account = await prisma.moneroAccount.create({ data: { ownerUserId: null, address: `qsweepc${userId}${Date.now()}`.slice(0, 95), label: 'q', network: 'STAGENET', status: 'ACTIVE' } })
  created.accounts.push(account.id)
  const [post] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", title, created_at) VALUES (${userId}::int, 'qsweep bank post', now()) RETURNING id::int AS id`
  created.items.push(post.id)
  await prisma.observedTip.create({ data: { txHash: `qsweep-bank-${Date.now()}`, postId: post.id, tipperId: userId, recipientAccountId: account.id, paymentId: `qsweep-bank-pid-${Date.now()}`, piconeros: 100000000n, state: 'DETECTED', detectedAt: new Date(now.getTime() - 5 * 60 * 1000) } })
  await prisma.payIn.create({ data: { userId, payInType: 'BOOST', payInState: 'PAID', piconeros: 100000000n, createdAt: new Date(now.getTime() - 4 * 60 * 1000) } })

  await sweepQuestCompletions({ models: prisma, now })
  expect(await prisma.questCompletion.count({ where: { userId, day: new Date(`${day}T00:00:00.000Z`) } })).toBe(2)
  const credits = await prisma.streakReward.findMany({ where: { userId, type: 'REPLY' } })
  expect(credits).toHaveLength(2) // one per quest

  await sweepQuestCompletions({ models: prisma, now }) // re-run: nothing new banks
  expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY' } })).toBe(2)
})

test('rev 4: a first responder completion banks two reply credits', async () => {
  const userId = await mkUser()
  let day = null
  for (let i = 0; i < 30 && !day; i++) {
    const d = utcDay(new Date(Date.now() + i * 86_400_000))
    if (drawFor(userId, d).drawn === QUEST.FIRST_RESPONDER) day = d
  }
  expect(day).not.toBeNull()
  const now = new Date(`${day}T12:00:00.000Z`)
  // An active run whose day-1 rung is already granted and whose today is
  // already counted, so the only new credits come from the doubled quest
  // reward (the upvote slot stays undone, so the day never clears).
  await prisma.streak.create({ data: { userId, type: 'FLAME', rewardLevel: 1, startedAt: new Date(`${day}T00:00:00.000Z`), lastEvaluatedDay: new Date(`${day}T00:00:00.000Z`) } })
  const [root] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", title, created_at) VALUES (${userId}::int, 'qsweep fr4 root', ${now}) RETURNING id::int AS id`
  const [comment] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", "parentId", "rootId", text, created_at) VALUES (${userId}::int, ${root.id}::int, ${root.id}::int, 'qsweep fr4 reply', ${now}) RETURNING id::int AS id`
  created.items.push(root.id, comment.id)

  await sweepQuestCompletions({ models: prisma, now })

  expect(await prisma.questCompletion.count({ where: { userId, day: new Date(`${day}T00:00:00.000Z`), quest: QUEST.FIRST_RESPONDER } })).toBe(1)
  const credits = await prisma.streakReward.findMany({ where: { userId, type: 'REPLY' } })
  expect(credits).toHaveLength(2)
})

test('rev 4: a double reward fills to the banked cap and stops', async () => {
  const userId = await mkUser()
  let day = null
  for (let i = 0; i < 30 && !day; i++) {
    const d = utcDay(new Date(Date.now() + i * 86_400_000))
    if (drawFor(userId, d).drawn === QUEST.FIRST_RESPONDER) day = d
  }
  expect(day).not.toBeNull()
  const now = new Date(`${day}T12:00:00.000Z`)
  await prisma.streak.create({ data: { userId, type: 'FLAME', rewardLevel: 1, startedAt: new Date(`${day}T00:00:00.000Z`), lastEvaluatedDay: new Date(`${day}T00:00:00.000Z`) } })
  await prisma.streakReward.createMany({
    data: Array.from({ length: 14 }, () => ({ userId, type: 'REPLY', expiresAt: new Date(Date.now() + 86_400_000) }))
  })
  const [root] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", title, created_at) VALUES (${userId}::int, 'qsweep fr4cap root', ${now}) RETURNING id::int AS id`
  const [comment] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", "parentId", "rootId", text, created_at) VALUES (${userId}::int, ${root.id}::int, ${root.id}::int, 'qsweep fr4cap reply', ${now}) RETURNING id::int AS id`
  created.items.push(root.id, comment.id)

  await sweepQuestCompletions({ models: prisma, now })

  // 14 held + the +2 grant fills to exactly 15 and never crosses.
  expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY' } })).toBe(15)
})
