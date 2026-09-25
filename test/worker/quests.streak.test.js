/* eslint-env jest */
import { PrismaClient } from '@prisma/client'
import { advanceQuestStreak, evaluateQuestStreaks } from '@/worker/streak'
import { utcDay, QUEST } from '@/lib/quests'
import { notifyShieldUsed } from '@/lib/webPush'

jest.mock('../../lib/webPush', () => ({
  notifyFlameAdvanced: jest.fn(() => Promise.resolve()),
  notifyShieldUsed: jest.fn(() => Promise.resolve()),
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

async function mkStreak (userId, { rewardLevel = 0, ended = false, lastEvaluatedDay = null, goldActive = false } = {}) {
  const s = await prisma.streak.create({ data: { userId, type: 'FLAME', startedAt: new Date(`${yesterday}T00:00:00.000Z`), endedAt: ended ? new Date() : null, rewardLevel, lastEvaluatedDay, goldActive } })
  created.streaks.push(s.id)
  return s
}

async function bothCleared (userId, day = yesterday) {
  await prisma.questCompletion.createMany({
    data: [
      { userId, day: new Date(`${day}T00:00:00.000Z`), quest: QUEST.UPVOTE },
      { userId, day: new Date(`${day}T00:00:00.000Z`), quest: QUEST.BOOST }
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
  expect(rewards).toHaveLength(1) // level 3 banks the day-3 reply exactly once
  expect(rewards[0].type).toBe('REPLY')
})

test('reaching day 4 arms the shield; a missed day consumes it and holds the run', async () => {
  const userId = await mkUser(3)
  await mkStreak(userId, { rewardLevel: 3 })
  await bothCleared(userId)
  await evaluateQuestStreaks({ models: prisma })
  let [s] = await prisma.streak.findMany({ where: { userId } })
  expect(s.goldActive).toBe(true)
  expect(notifyShieldUsed).not.toHaveBeenCalled()

  // next day missed: the shield absorbs it, the run holds at level 4
  await evaluateQuestStreaks({ models: prisma, now: new Date(Date.now() + 86_400_000) })
  const [user] = await prisma.$queryRaw`SELECT streak FROM users WHERE id = ${userId}::int`
  expect(user.streak).toBe(4)
  ;[s] = await prisma.streak.findMany({ where: { userId } })
  expect(s.endedAt).toBeNull()
  expect(s.goldActive).toBe(false)
  expect(notifyShieldUsed).toHaveBeenCalledTimes(1)
})

test('a missed day without a shield ends the run, and the next run starts unarmed', async () => {
  const userId = await mkUser(2)
  await mkStreak(userId, { rewardLevel: 2 })
  await evaluateQuestStreaks({ models: prisma })
  const [user] = await prisma.$queryRaw`SELECT streak FROM users WHERE id = ${userId}::int`
  expect(user.streak).toBeNull()
  const [s] = await prisma.streak.findMany({ where: { userId } })
  expect(s.endedAt).not.toBeNull()

  // the next cleared day starts a fresh run with no shield
  await bothCleared(userId, utcDay())
  await advanceQuestStreak({ models: prisma, userId, day: utcDay() })
  const [fresh] = await prisma.streak.findMany({ where: { userId, endedAt: null } })
  expect(fresh.goldActive).toBe(false)
})

test('the shield re-arms at the next week day 4 and reply grants bank capped credits', async () => {
  const userId = await mkUser(10)
  await mkStreak(userId, { rewardLevel: 10, goldActive: false })
  await bothCleared(userId)
  await evaluateQuestStreaks({ models: prisma })
  const [s] = await prisma.streak.findMany({ where: { userId } })
  expect(s.goldActive).toBe(true) // level 11 = week 2 day 4
  expect(s.rewardLevel).toBe(11)
  // level 11 is the day-4 rung, so no credit is granted; the reply comes at 12
  const replies = await prisma.streakReward.findMany({ where: { userId, type: 'REPLY' } })
  expect(replies).toHaveLength(0)
})

test('a catch-up grant stops at the cap mid-loop and still advances the marker', async () => {
  const userId = await mkUser(10)
  await mkStreak(userId, { rewardLevel: 8, goldActive: true }) // marker lags two levels
  await prisma.streakReward.createMany({
    data: Array.from({ length: 15 }, () => ({
      userId, type: 'REPLY', expiresAt: new Date(Date.now() + 86_400_000)
    }))
  })
  await prisma.streakReward.createMany({
    data: Array.from({ length: 5 }, () => ({
      userId, type: 'POST', expiresAt: new Date(Date.now() + 86_400_000)
    }))
  })
  await bothCleared(userId)
  await evaluateQuestStreaks({ models: prisma })
  // the loop spans levels 9 (post), 10 (reply), 11 (goldflame): both credit
  // types are at their caps, so nothing is added, but the marker and the
  // shield still move
  expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY' } })).toBe(15)
  expect(await prisma.streakReward.count({ where: { userId, type: 'POST' } })).toBe(5)
  const [s] = await prisma.streak.findMany({ where: { userId } })
  expect(s.rewardLevel).toBe(11)
  expect(s.goldActive).toBe(true)
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
  // Crash inside the ladder grant (the shield arm write) on the first run.
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
  expect(sBefore.goldActive).toBe(false)

  // Retry on the healthy client: exactly one advance and one shield arm.
  await evaluateQuestStreaks({ models: prisma })
  const [after] = await prisma.$queryRaw`SELECT streak FROM users WHERE id = ${userId}::int`
  expect(after.streak).toBe(4)
  expect(await prisma.streakReward.findMany({ where: { userId } })).toHaveLength(0)
  const [sAfter] = await prisma.streak.findMany({ where: { userId } })
  expect(sAfter.goldActive).toBe(true)
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

  // The sweep's path defers: the 00:10 evaluation may yet apply the shield or drop.
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
