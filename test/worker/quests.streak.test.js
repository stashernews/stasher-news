/* eslint-env jest */
import { PrismaClient } from '@prisma/client'
import { advanceQuestStreak, evaluateQuestStreaks } from '@/worker/streak'
import { utcDay, QUEST } from '@/lib/quests'

jest.mock('../../lib/webPush', () => ({
  notifyFlameAdvanced: jest.fn(() => Promise.resolve()),
  notifyFreezeUsed: jest.fn(() => Promise.resolve()),
  notifyStreakLost: jest.fn(() => Promise.resolve())
}))

const prisma = new PrismaClient()
const yesterday = utcDay(new Date(Date.now() - 86_400_000))
const created = { users: [], streaks: [] }

async function mkUser (streak = null) {
  const [row] = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(row.id)
  if (streak != null) await prisma.$executeRaw`UPDATE users SET streak = ${streak} WHERE id = ${row.id}::int`
  return row.id
}

async function mkStreak (userId, { rewardLevel = 0, ended = false, lastEvaluatedDay = null } = {}) {
  const s = await prisma.streak.create({ data: { userId, type: 'FLAME', startedAt: new Date(`${yesterday}T00:00:00.000Z`), endedAt: ended ? new Date() : null, rewardLevel, lastEvaluatedDay } })
  created.streaks.push(s.id)
  return s
}

async function bothCleared (userId) {
  await prisma.questCompletion.createMany({
    data: [
      { userId, day: new Date(`${yesterday}T00:00:00.000Z`), quest: QUEST.UPVOTE },
      { userId, day: new Date(`${yesterday}T00:00:00.000Z`), quest: QUEST.BOOST }
    ]
  })
}

afterAll(async () => {
  await prisma.streakReward.deleteMany({ where: { userId: { in: created.users } } })
  await prisma.questCompletion.deleteMany({ where: { userId: { in: created.users } } })
  await prisma.streak.deleteMany({ where: { id: { in: created.streaks } } })
  await prisma.user.deleteMany({ where: { id: { in: created.users } } })
  await prisma.$disconnect()
})

test('clearing both quests advances and grants the ladder reward for the new level', async () => {
  const userId = await mkUser(1)
  await mkStreak(userId, { rewardLevel: 1 })
  await bothCleared(userId)
  await evaluateQuestStreaks({ models: prisma })
  const [user] = await prisma.$queryRaw`SELECT streak FROM users WHERE id = ${userId}::int`
  expect(user.streak).toBe(2)
  const rewards = await prisma.streakReward.findMany({ where: { userId } })
  expect(rewards.filter(r => r.type === 'POST')).toHaveLength(1)
  const [s] = await prisma.streak.findMany({ where: { userId } })
  expect(s.rewardLevel).toBe(2)
})

test('re-running never double-advances or double-grants (day guard + marker idempotency)', async () => {
  const userId = await mkUser(2)
  await mkStreak(userId, { rewardLevel: 2 })
  await bothCleared(userId)
  await evaluateQuestStreaks({ models: prisma })
  await evaluateQuestStreaks({ models: prisma })
  const [user] = await prisma.$queryRaw`SELECT streak FROM users WHERE id = ${userId}::int`
  expect(user.streak).toBe(3) // advanced exactly once for the day
  const rewards = await prisma.streakReward.findMany({ where: { userId } })
  expect(rewards).toHaveLength(0) // level 3 is the reply bonus (no ledger row)
})

test('day 4 grants a freeze; a later day 4 suppresses while one is held', async () => {
  const a = await mkUser(3); await mkStreak(a, { rewardLevel: 3 }); await bothCleared(a)
  const b = await mkUser(3); await mkStreak(b, { rewardLevel: 3 }); await bothCleared(b)
  // b already holds an unconsumed freeze
  await prisma.streakReward.create({ data: { userId: b, type: 'FREEZE', expiresAt: new Date(Date.now() + 86_400_000) } })
  await evaluateQuestStreaks({ models: prisma })
  const aFreezes = await prisma.streakReward.findMany({ where: { userId: a, type: 'FREEZE' } })
  const bFreezes = await prisma.streakReward.findMany({ where: { userId: b, type: 'FREEZE' } })
  expect(aFreezes).toHaveLength(1)
  expect(bFreezes).toHaveLength(1) // suppressed, not stacked
})

test('a missed day consumes the freeze and holds the streak', async () => {
  const userId = await mkUser(4)
  await mkStreak(userId, { rewardLevel: 4 })
  await prisma.streakReward.create({ data: { userId, type: 'FREEZE', expiresAt: new Date(Date.now() + 86_400_000) } })
  await evaluateQuestStreaks({ models: prisma }) // no completions for yesterday
  const [user] = await prisma.$queryRaw`SELECT streak FROM users WHERE id = ${userId}::int`
  expect(user.streak).toBe(4) // held
  const freezes = await prisma.streakReward.findMany({ where: { userId, type: 'FREEZE' } })
  expect(freezes[0].consumedAt).not.toBeNull()
  const [s] = await prisma.streak.findMany({ where: { userId } })
  expect(s.endedAt).toBeNull()
})

test('a missed day without a freeze ends the streak', async () => {
  const userId = await mkUser(5)
  await mkStreak(userId, { rewardLevel: 5 })
  await evaluateQuestStreaks({ models: prisma })
  const [user] = await prisma.$queryRaw`SELECT streak FROM users WHERE id = ${userId}::int`
  expect(user.streak).toBeNull()
  const [s] = await prisma.streak.findMany({ where: { userId } })
  expect(s.endedAt).not.toBeNull()
})

test('a first clear starts the streak at day 1', async () => {
  const userId = await mkUser(null)
  await bothCleared(userId)
  await evaluateQuestStreaks({ models: prisma })
  const [user] = await prisma.$queryRaw`SELECT streak FROM users WHERE id = ${userId}::int`
  expect(user.streak).toBe(1)
})

test('a crash mid-evaluation rolls back atomically; a retry then advances exactly once', async () => {
  const userId = await mkUser(3)
  await mkStreak(userId, { rewardLevel: 3 })
  await bothCleared(userId)
  // Crash inside the ladder grant (the marker write) on the first run.
  const faulty = prisma.$extends({
    query: {
      streak: {
        async update () { throw new Error('boom') }
      }
    }
  })
  await expect(evaluateQuestStreaks({ models: faulty })).rejects.toThrow('boom')

  // Rolled back: no phantom advance, no partial grants, guard still unset.
  const [before] = await prisma.$queryRaw`SELECT streak FROM users WHERE id = ${userId}::int`
  expect(before.streak).toBe(3)
  expect(await prisma.streakReward.findMany({ where: { userId } })).toHaveLength(0)
  const [sBefore] = await prisma.streak.findMany({ where: { userId } })
  expect(sBefore.lastEvaluatedDay).toBeNull()

  // Retry on the healthy client: exactly one advance and one freeze grant.
  await evaluateQuestStreaks({ models: prisma })
  const [after] = await prisma.$queryRaw`SELECT streak FROM users WHERE id = ${userId}::int`
  expect(after.streak).toBe(4)
  const freezes = await prisma.streakReward.findMany({ where: { userId, type: 'FREEZE' } })
  expect(freezes).toHaveLength(1)
})

test('the immediate advance defers while the previous day is unsettled', async () => {
  const userId = await mkUser(4)
  await mkStreak(userId, { rewardLevel: 4 }) // lastEvaluatedDay null: the previous day is pending
  const today = utcDay(new Date())
  const dayDate = new Date(`${today}T00:00:00.000Z`)
  await prisma.questCompletion.createMany({
    data: [
      { userId, day: dayDate, quest: QUEST.UPVOTE },
      { userId, day: dayDate, quest: QUEST.BOOST }
    ]
  })

  // The sweep's path defers: the 00:10 evaluation may yet apply a freeze/drop.
  expect(await advanceQuestStreak({ models: prisma, userId, day: today, requirePrevSettled: true })).toBeNull()
  const [before] = await prisma.$queryRaw`SELECT streak FROM users WHERE id = ${userId}::int`
  expect(before.streak).toBe(4)

  // The evaluation path advances, and the day guard makes a re-run a no-op.
  const notification = await advanceQuestStreak({ models: prisma, userId, day: today })
  expect(notification?.level).toBe(5)
  expect(await advanceQuestStreak({ models: prisma, userId, day: today })).toBeNull()
  const [after] = await prisma.$queryRaw`SELECT streak FROM users WHERE id = ${userId}::int`
  expect(after.streak).toBe(5)
})

test('the immediate advance runs once the previous day is settled', async () => {
  const userId = await mkUser(2)
  await mkStreak(userId, { rewardLevel: 2, lastEvaluatedDay: new Date(`${yesterday}T00:00:00.000Z`) })
  const today = utcDay(new Date())
  await prisma.questCompletion.createMany({
    data: [
      { userId, day: new Date(`${today}T00:00:00.000Z`), quest: QUEST.UPVOTE },
      { userId, day: new Date(`${today}T00:00:00.000Z`), quest: QUEST.BOOST }
    ]
  })

  const notification = await advanceQuestStreak({ models: prisma, userId, day: today, requirePrevSettled: true })
  expect(notification?.level).toBe(3)
  const [user] = await prisma.$queryRaw`SELECT streak FROM users WHERE id = ${userId}::int`
  expect(user.streak).toBe(3)
})
