/* eslint-env jest */
import { PrismaClient } from '@prisma/client'
import { advanceQuestStreak, evaluateQuestStreaks } from '@/worker/streak'
import { utcDay, QUEST, drawFor, FLAME_TOP_TIER, MAX_BANKED_BOOSTS } from '@/lib/quests'
import { sweepQuestCompletions } from '@/worker/quests'
import { notifyShieldUsed, notifyFlameAdvanced } from '@/lib/webPush'

jest.mock('../../lib/webPush', () => ({
  notifyFlameAdvanced: jest.fn(() => Promise.resolve()),
  notifyQuestCompleted: jest.fn(() => Promise.resolve()),
  notifyShieldUsed: jest.fn(() => Promise.resolve()),
  notifyStreakLost: jest.fn(() => Promise.resolve())
}))

// The scheduled-retry timing diagnostics run through this logger; mock it so
// expected-failure tests stay quiet and no pino output leaks into test output.
jest.mock('../../lib/logger', () => ({
  __esModule: true,
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn()
}))

const prisma = new PrismaClient()
const yesterday = utcDay(new Date(Date.now() - 86_400_000))
const created = { users: [], streaks: [], items: [] }

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

test('evaluations with a user allowlist never touch other users\' runs', async () => {
  // Test-isolation seam: the dev DB holds real users' runs. An evaluation
  // scoped to the fixtures must leave every other run exactly as it was.
  const fixture = await mkUser(10)
  await mkStreak(fixture, { rewardLevel: 3 })
  const outsider = await mkUser(10)
  const twoDaysAgo = new Date(new Date(`${yesterday}T00:00:00.000Z`).getTime() - 86_400_000)
  await mkStreak(outsider, { rewardLevel: 3, lastEvaluatedDay: twoDaysAgo })

  await evaluateQuestStreaks({ models: prisma, userIds: [fixture] })

  const [after] = await prisma.streak.findMany({ where: { userId: outsider }, orderBy: { id: 'desc' } })
  expect(after.endedAt).toBeNull()
  expect(after.rewardLevel).toBe(3)
  expect(after.lastEvaluatedDay).toEqual(twoDaysAgo)
})

afterAll(async () => {
  await prisma.streakReward.deleteMany({ where: { userId: { in: created.users } } })
  await prisma.questCompletion.deleteMany({ where: { userId: { in: created.users } } })
  await prisma.streak.deleteMany({ where: { id: { in: created.streaks } } })
  for (const id of [...created.items].reverse()) await prisma.item.deleteMany({ where: { id } })
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
  expect(rewards.filter(r => r.type === 'BOOST')).toHaveLength(1)
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
  // level 11 is the day-4 rung, so no credit is granted; week 2's boost rung
  // was day 2 (level 9), already behind the marker
  const replies = await prisma.streakReward.findMany({ where: { userId, type: 'REPLY' } })
  expect(replies).toHaveLength(0)
  expect(await prisma.streakReward.count({ where: { userId, type: 'BOOST' } })).toBe(0)
})

test('a catch-up grant stops at the cap mid-loop and still advances the marker', async () => {
  const userId = await mkUser(10)
  await mkStreak(userId, { rewardLevel: 8, goldActive: true }) // marker lags two levels
  await prisma.streakReward.createMany({
    data: Array.from({ length: 10 }, () => ({
      userId, type: 'REPLY', expiresAt: new Date(Date.now() + 86_400_000)
    }))
  })
  await prisma.streakReward.createMany({
    data: Array.from({ length: 5 }, () => ({
      userId, type: 'POST', expiresAt: new Date(Date.now() + 86_400_000)
    }))
  })
  await prisma.streakReward.createMany({
    data: Array.from({ length: MAX_BANKED_BOOSTS }, () => ({
      userId, type: 'BOOST', grantedAt: new Date(), expiresAt: new Date(Date.now() + 30 * 86_400_000)
    }))
  })
  await bothCleared(userId)
  await evaluateQuestStreaks({ models: prisma })
  // the loop spans levels 9 (boost, held), 10 (reply, capped), 11 (goldflame):
  // every rung is suppressed, but the marker and the shield still move
  expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY' } })).toBe(10)
  expect(await prisma.streakReward.count({ where: { userId, type: 'POST' } })).toBe(5)
  expect(await prisma.streakReward.count({ where: { userId, type: 'BOOST' } })).toBe(MAX_BANKED_BOOSTS)
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

test('a later daily backstop settles the original failed day before the newer clear', async () => {
  const userId = await mkUser(2)
  const run = await mkStreak(userId, { rewardLevel: 2, lastEvaluatedDay: new Date('2026-10-09T00:00:00Z') })
  await prisma.streak.update({ where: { id: run.id }, data: { startedAt: new Date('2026-10-08T00:00:00Z') } })
  await bothCleared(userId, '2026-10-10')
  await bothCleared(userId, '2026-10-11')
  const faulty = prisma.$extends({
    query: {
      streak: {
        async update () { throw new Error('evaluation interrupted') }
      }
    }
  })
  await expect(evaluateQuestStreaks({ models: faulty, now: new Date('2026-10-11T00:10:00Z'), userIds: [userId] }))
    .rejects.toThrow('evaluation interrupted')
  const options = { models: prisma, now: new Date('2026-10-12T00:10:00Z'), userIds: [userId] }
  await evaluateQuestStreaks(options)
  await evaluateQuestStreaks(options)
  const user = await prisma.user.findUnique({ where: { id: userId } })
  const after = await prisma.streak.findUnique({ where: { id: run.id } })
  expect(user.streak).toBe(4)
  expect(after.lastEvaluatedDay).toEqual(new Date('2026-10-11T00:00:00Z'))
  expect(after.goldActive).toBe(true)
  expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY' } })).toBe(1)
})

test.each([true, false])('a missed old day applies shield=%s before the later clear', async goldActive => {
  const userId = await mkUser(4)
  const run = await mkStreak(userId, { rewardLevel: 4, goldActive, lastEvaluatedDay: new Date('2026-10-09T00:00:00Z') })
  await prisma.streak.update({ where: { id: run.id }, data: { startedAt: new Date('2026-10-08T00:00:00Z') } })
  await bothCleared(userId, '2026-10-11')
  await evaluateQuestStreaks({ models: prisma, now: new Date('2026-10-12T00:10:00Z'), userIds: [userId] })
  const user = await prisma.user.findUnique({ where: { id: userId } })
  const old = await prisma.streak.findUnique({ where: { id: run.id } })
  expect(user.streak).toBe(goldActive ? 5 : 1)
  expect(old.goldActive).toBe(false)
  expect(old.endedAt).toEqual(goldActive ? null : new Date('2026-10-10T00:00:00Z'))
})

test('the sweep cannot leapfrog an earlier clear when the first run never committed', async () => {
  const userId = await mkUser()
  await bothCleared(userId, '2026-10-10')
  await bothCleared(userId, '2026-10-11')
  expect(await advanceQuestStreak({ models: prisma, userId, day: '2026-10-11', requirePrevSettled: true })).toBeNull()
  expect(await prisma.streak.count({ where: { userId } })).toBe(0)
  await evaluateQuestStreaks({ models: prisma, now: new Date('2026-10-12T00:10:00Z'), userIds: [userId] })
  const user = await prisma.user.findUnique({ where: { id: userId } })
  expect(user.streak).toBe(2)
})

test('the seven-day catch-up cap retains durable progress rather than jumping to yesterday', async () => {
  const userId = await mkUser()
  for (let day = 1; day <= 9; day++) await bothCleared(userId, `2026-10-0${day}`)
  const options = { models: prisma, now: new Date('2026-10-10T00:10:00Z'), userIds: [userId] }
  await evaluateQuestStreaks(options)
  const first = await prisma.streak.findFirst({ where: { userId, endedAt: null } })
  expect(first.lastEvaluatedDay).toEqual(new Date('2026-10-07T00:00:00Z'))
  await evaluateQuestStreaks(options)
  const after = await prisma.user.findUnique({ where: { id: userId } })
  expect(after.streak).toBe(9)
})

test('one broken user does not prevent another user from settling', async () => {
  const first = await mkUser()
  const second = await mkUser()
  await bothCleared(first, '2026-10-11')
  await bothCleared(second, '2026-10-11')
  const faulty = prisma.$extends({
    query: {
      user: {
        async update ({ args, query }) {
          if (args.where.id === first) throw new Error('first user interrupted')
          return query(args)
        }
      }
    }
  })
  await expect(evaluateQuestStreaks({ models: faulty, now: new Date('2026-10-12T00:10:00Z'), userIds: [first, second] }))
    .rejects.toThrow('first user interrupted')
  expect((await prisma.user.findUnique({ where: { id: first } })).streak).toBeNull()
  expect((await prisma.user.findUnique({ where: { id: second } })).streak).toBe(1)
})

test.each([true, false])('a completion committed after the missed-day snapshot advances without consuming shield=%s', async goldActive => {
  const userId = await mkUser(5)
  let day = null
  for (let i = 0; i < 30 && !day; i++) {
    const candidate = utcDay(new Date(Date.now() + i * 86_400_000))
    if (drawFor(userId, candidate).drawn === QUEST.FIRST_RESPONDER) day = candidate
  }
  expect(day).not.toBeNull()
  const dayDate = new Date(`${day}T00:00:00Z`)
  const sweepNow = new Date(`${day}T12:00:00Z`)
  const run = await mkStreak(userId, { rewardLevel: 5, goldActive, lastEvaluatedDay: new Date(dayDate.getTime() - 86_400_000) })
  await prisma.streak.update({ where: { id: run.id }, data: { startedAt: new Date(dayDate.getTime() - 2 * 86_400_000) } })
  await prisma.questCompletion.create({ data: { userId, day: dayDate, quest: QUEST.UPVOTE } })
  const [root] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", title, created_at) VALUES (${userId}::int, 'settlement race root', ${sweepNow}) RETURNING id::int AS id`
  const [comment] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", "parentId", "rootId", text, created_at) VALUES (${userId}::int, ${root.id}::int, ${root.id}::int, 'settlement race reply', ${sweepNow}) RETURNING id::int AS id`
  created.items.push(root.id, comment.id)
  // Reproduce the real crash window: the sweep commits completion+banking,
  // then its independent advancement fails before the evaluator takes the lock.
  const interruptedSweep = prisma.$extends({
    query: {
      streak: { async findFirst () { throw new Error('sweep advancement interrupted') } }
    }
  })
  let raced = false
  const evaluator = prisma.$extends({
    query: {
      async $queryRaw ({ args, query }) {
        const snapshot = await query(args)
        const sql = args?.strings?.join('') ?? String(args?.sql ?? args?.[0])
        if (!raced && /SELECT\s+"userId"\s+FROM\s+"QuestCompletion"/.test(sql)) {
          raced = true
          expect(snapshot).toHaveLength(0)
          await expect(sweepQuestCompletions({ models: interruptedSweep, now: sweepNow, userIds: [userId] }))
            .rejects.toThrow('sweep advancement interrupted')
          expect(await prisma.questCompletion.count({ where: { userId, day: dayDate } })).toBe(2)
        }
        return snapshot
      }
    }
  })
  notifyShieldUsed.mockClear()
  notifyFlameAdvanced.mockClear()
  const options = { models: evaluator, now: new Date(dayDate.getTime() + 86_400_000 + 600_000), userIds: [userId] }
  await evaluateQuestStreaks(options)
  await evaluateQuestStreaks({ ...options, models: prisma })
  expect(raced).toBe(true)
  expect((await prisma.user.findUnique({ where: { id: userId } })).streak).toBe(6)
  const after = await prisma.streak.findUnique({ where: { id: run.id } })
  expect(after.endedAt).toBeNull()
  expect(after.goldActive).toBe(goldActive)
  expect(after.lastEvaluatedDay).toEqual(dayDate)
  expect(await prisma.streakReward.count({ where: { userId, type: 'BOOST' } })).toBe(1)
  expect(notifyShieldUsed).not.toHaveBeenCalled()
  expect(notifyFlameAdvanced.mock.calls.filter(([id]) => id === userId)).toHaveLength(1)
})

// Boost credit rung: up to MAX_BANKED_BOOSTS held credits, exactly 30 days of
// expiry, suppression never refreshes a held row, and the marker advances even
// when suppressed.

async function seedBoosts (userId, count, data = {}) {
  const grantedAt = new Date(Date.now() - 3 * 86_400_000)
  const expiresAt = new Date(grantedAt.getTime() + 30 * 86_400_000)
  for (let i = 0; i < count; i++) {
    await prisma.streakReward.create({ data: { userId, type: 'BOOST', grantedAt, expiresAt, ...data } })
  }
  return { grantedAt, expiresAt }
}

test('clearing day 6 grants exactly one BOOST credit expiring in 30 days', async () => {
  const userId = await mkUser(5)
  await mkStreak(userId, { rewardLevel: 5 })
  await bothCleared(userId)
  await evaluateQuestStreaks({ models: prisma, userIds: [userId] })

  const [user] = await prisma.$queryRaw`SELECT streak FROM users WHERE id = ${userId}::int`
  expect(user.streak).toBe(6)
  const credit = await prisma.streakReward.findFirst({ where: { userId, type: 'BOOST' } })
  expect(credit).not.toBeNull()
  // exact boost expiry: grantedAt-to-expiresAt is 30 spans of 24 real hours
  expect(credit.expiresAt.getTime() - credit.grantedAt.getTime()).toBe(30 * 86_400_000)
  const [s] = await prisma.streak.findMany({ where: { userId } })
  expect(s.rewardLevel).toBe(6)
  // the advanced notification names the banked boost
  const calls = notifyFlameAdvanced.mock.calls.filter(([id]) => id === userId)
  expect(calls).toHaveLength(1)
  const [, payload] = calls[0]
  expect(payload.rewards).toEqual([{ level: 6, kind: 'boost' }])
})

test('credits below the cap stack: three held still grant a fourth', async () => {
  const userId = await mkUser(5)
  await mkStreak(userId, { rewardLevel: 5 })
  await seedBoosts(userId, MAX_BANKED_BOOSTS - 1)
  await bothCleared(userId)
  await evaluateQuestStreaks({ models: prisma, userIds: [userId] })
  expect(await prisma.streakReward.count({ where: { userId, type: 'BOOST' } })).toBe(MAX_BANKED_BOOSTS)
})

test('a full bank suppresses the rung without refreshing any expiry', async () => {
  const userId = await mkUser(5)
  await mkStreak(userId, { rewardLevel: 5 })
  const { grantedAt, expiresAt } = await seedBoosts(userId, MAX_BANKED_BOOSTS)
  await bothCleared(userId)
  await evaluateQuestStreaks({ models: prisma, userIds: [userId] })

  // the rung is suppressed: only the held rows, untouched
  const rows = await prisma.streakReward.findMany({ where: { userId, type: 'BOOST' } })
  expect(rows).toHaveLength(MAX_BANKED_BOOSTS)
  for (const row of rows) {
    expect(row.grantedAt.getTime()).toBe(grantedAt.getTime())
    expect(row.expiresAt.getTime()).toBe(expiresAt.getTime())
    expect(row.consumedAt).toBeNull()
  }

  // level and marker still advance (a suppressed rung is not saved for later)
  const [user] = await prisma.$queryRaw`SELECT streak FROM users WHERE id = ${userId}::int`
  expect(user.streak).toBe(6)
  const [s] = await prisma.streak.findMany({ where: { userId } })
  expect(s.rewardLevel).toBe(6)
  // the notification claims no boost was banked
  const calls = notifyFlameAdvanced.mock.calls.filter(([id]) => id === userId)
  expect(calls).toHaveLength(1)
  const [, payload] = calls[0]
  expect(payload.rewards).toEqual([])
})

test('consumed and expired BOOST rows do not count toward the cap', async () => {
  const seeds = [
    // consumed: spent rows never suppress a future rung
    { expiresAt: new Date(Date.now() + 86_400_000), consumedAt: new Date() },
    // expired: an outstanding row that ran out does not either
    { grantedAt: new Date(Date.now() - 40 * 86_400_000), expiresAt: new Date(Date.now() - 86_400_000) }
  ]
  for (const seed of seeds) {
    const userId = await mkUser(5)
    await mkStreak(userId, { rewardLevel: 5 })
    await seedBoosts(userId, MAX_BANKED_BOOSTS, seed)
    await bothCleared(userId)
    await evaluateQuestStreaks({ models: prisma, userIds: [userId] })

    const rows = await prisma.streakReward.findMany({
      where: { userId, type: 'BOOST' },
      orderBy: { id: 'desc' }
    })
    // the rung grants a fresh future row next to the spent/expired ones
    expect(rows).toHaveLength(MAX_BANKED_BOOSTS + 1)
    const fresh = rows[0]
    expect(fresh.consumedAt).toBeNull()
    expect(fresh.expiresAt.getTime()).toBeGreaterThan(Date.now())
    expect(fresh.expiresAt.getTime() - fresh.grantedAt.getTime()).toBe(30 * 86_400_000)
  }
})

// --- week-parity rungs ---

test('week 1 day 7 banks a post, not a turf discount', async () => {
  const userId = await mkUser(6)
  const run = await mkStreak(userId, { rewardLevel: 6 })
  await bothCleared(userId)
  await evaluateQuestStreaks({ models: prisma, userIds: [userId] })
  expect(await prisma.streakReward.count({ where: { userId, type: 'POST', streakId: run.id } })).toBe(1)
  expect(await prisma.streakReward.count({ where: { userId, type: 'TURF_DISCOUNT' } })).toBe(0)
})

test('week 2 grants its full set: boost, post, shield, reply, boost, discount', async () => {
  const userId = await mkUser(13) // marker lags six levels: 9..14 grant together
  const run = await mkStreak(userId, { rewardLevel: 8 })
  await bothCleared(userId)
  await evaluateQuestStreaks({ models: prisma, userIds: [userId] })

  const [user] = await prisma.$queryRaw`SELECT streak FROM users WHERE id = ${userId}::int`
  expect(user.streak).toBe(14)
  expect(await prisma.streakReward.count({ where: { userId, type: 'BOOST', streakId: run.id } })).toBe(2)
  expect(await prisma.streakReward.count({ where: { userId, type: 'POST', streakId: run.id } })).toBe(1)
  expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY', streakId: run.id } })).toBe(1)
  expect(await prisma.streakReward.count({ where: { userId, type: 'TURF_DISCOUNT', streakId: run.id } })).toBe(1)
  const [s] = await prisma.streak.findMany({ where: { userId } })
  expect(s.rewardLevel).toBe(14)
  expect(s.goldActive).toBe(true)
})

// --- retroactive safety: a rung already completed and granted under an older
// ladder must never be re-granted, revoked, or re-evaluated when its day
// remaps — the marker is settled history ---

test('a settled rung that remaps is neither re-paid nor revoked', async () => {
  const userId = await mkUser(5) // the marker already covers 5, once a boost, now a reply
  const run = await mkStreak(userId, { rewardLevel: 5 })
  const grantedAt = new Date(Date.now() - 5 * 86_400_000)
  await prisma.streakReward.create({ data: { userId, type: 'BOOST', streakId: run.id, grantedAt, expiresAt: new Date(grantedAt.getTime() + 30 * 86_400_000) } })
  await bothCleared(userId)
  await evaluateQuestStreaks({ models: prisma, userIds: [userId] })

  // level 5 is settled history; only level 6 (a boost) grants
  const boosts = await prisma.streakReward.findMany({ where: { userId, type: 'BOOST' }, orderBy: { id: 'asc' } })
  expect(boosts).toHaveLength(2)
  expect(boosts[0].grantedAt.getTime()).toBe(grantedAt.getTime())
  expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY', streakId: run.id } })).toBe(0)
  const [s] = await prisma.streak.findMany({ where: { userId } })
  expect(s.rewardLevel).toBe(6)
})

test('a catch-up advance spanning several cycles stops at the boost cap', async () => {
  const userId = await mkUser(20)
  await mkStreak(userId, { rewardLevel: 0 }) // marker lags twenty levels back
  await bothCleared(userId)
  await evaluateQuestStreaks({ models: prisma, userIds: [userId] })

  const [user] = await prisma.$queryRaw`SELECT streak FROM users WHERE id = ${userId}::int`
  expect(user.streak).toBe(21)
  // six boost rungs were crossed (levels 2, 6, 9, 13, 16, 20); the cap stops them
  expect(await prisma.streakReward.count({ where: { userId, type: 'BOOST' } })).toBe(MAX_BANKED_BOOSTS)
  const [s] = await prisma.streak.findMany({ where: { userId } })
  expect(s.rewardLevel).toBe(21) // the marker advances regardless
})

test('ending the run does not revoke a banked BOOST credit', async () => {
  const userId = await mkUser(5)
  await mkStreak(userId, { rewardLevel: 5 })
  await bothCleared(userId)
  await evaluateQuestStreaks({ models: prisma, userIds: [userId] })
  expect(await prisma.streakReward.count({ where: { userId, type: 'BOOST' } })).toBe(1)

  // next day missed with no shield: the run ends, the credit stays held
  await evaluateQuestStreaks({ models: prisma, now: new Date(Date.now() + 86_400_000), userIds: [userId] })
  const [user] = await prisma.$queryRaw`SELECT streak FROM users WHERE id = ${userId}::int`
  expect(user.streak).toBeNull()
  const [s] = await prisma.streak.findMany({ where: { userId } })
  expect(s.endedAt).not.toBeNull()
  expect(await prisma.streakReward.count({ where: { userId, type: 'BOOST' } })).toBe(1)
})

test('two concurrent advances for one cleared day grant one BOOST and one notification', async () => {
  const userId = await mkUser(5)
  const today = utcDay(new Date())
  await mkStreak(userId, { rewardLevel: 5, lastEvaluatedDay: new Date(`${yesterday}T00:00:00.000Z`) })
  await prisma.questCompletion.createMany({
    data: [
      { userId, day: new Date(`${today}T00:00:00.000Z`), quest: QUEST.UPVOTE },
      { userId, day: new Date(`${today}T00:00:00.000Z`), quest: QUEST.BOOST }
    ]
  })

  const [a, b] = await Promise.all([
    advanceQuestStreak({ models: prisma, userId, day: today, requirePrevSettled: true }),
    advanceQuestStreak({ models: prisma, userId, day: today, requirePrevSettled: true })
  ])
  const notifications = [a, b].filter(Boolean)
  // the user lock serializes the writes: exactly one advance wins
  expect(notifications).toHaveLength(1)
  expect(notifications[0].level).toBe(6)
  expect(await prisma.streakReward.count({ where: { userId, type: 'BOOST' } })).toBe(1)
  const [user] = await prisma.$queryRaw`SELECT streak FROM users WHERE id = ${userId}::int`
  expect(user.streak).toBe(6)
})

test('concurrent advances for different users stay isolated', async () => {
  const ids = [await mkUser(5), await mkUser(5)]
  const today = utcDay(new Date())
  for (const userId of ids) {
    await mkStreak(userId, { rewardLevel: 5, lastEvaluatedDay: new Date(`${yesterday}T00:00:00.000Z`) })
    await prisma.questCompletion.createMany({
      data: [
        { userId, day: new Date(`${today}T00:00:00.000Z`), quest: QUEST.UPVOTE },
        { userId, day: new Date(`${today}T00:00:00.000Z`), quest: QUEST.BOOST }
      ]
    })
  }

  const notifications = await Promise.all(
    ids.map(userId => advanceQuestStreak({ models: prisma, userId, day: today, requirePrevSettled: true }))
  )
  // one user's lock never blocks the other's rung
  for (let i = 0; i < ids.length; i++) {
    expect(notifications[i]?.level).toBe(6)
    expect(await prisma.streakReward.count({ where: { userId: ids[i], type: 'BOOST' } })).toBe(1)
  }
})

// --- flame level-up rung and shield decay ---

async function clearLevelUp (level, shield = {}) {
  const userId = await mkUser(level - 1)
  const run = await mkStreak(userId, { rewardLevel: level - 1, ...shield })
  if (shield.flameTier) await prisma.streak.update({ where: { id: run.id }, data: { flameTier: shield.flameTier } })
  await bothCleared(userId)
  await evaluateQuestStreaks({ models: prisma, userIds: [userId] })
  return { userId, run: await prisma.streak.findUnique({ where: { id: run.id } }) }
}

const bestTier = async userId => (await prisma.user.findUnique({ where: { id: userId } })).bestFlameTier

test('the level-up rung makes a flame with no shield level 2 with that week\'s look', async () => {
  const { userId, run } = await clearLevelUp(28)
  expect(run.goldActive).toBe(true)
  expect(run.flameTier).toBe(4)
  expect(await bestTier(userId)).toBe(4)
  const [, payload] = notifyFlameAdvanced.mock.calls.find(([id]) => id === userId)
  expect(payload.rewards).toEqual([{ level: 28, kind: 'flameup' }])
})

test('the level-up rung makes a golden flame level 2 with that week\'s look', async () => {
  const { userId, run } = await clearLevelUp(28, { goldActive: true })
  expect(run.goldActive).toBe(true)
  expect(run.flameTier).toBe(4)
  expect(await bestTier(userId)).toBe(4)
  const [, payload] = notifyFlameAdvanced.mock.calls.find(([id]) => id === userId)
  expect(payload.rewards).toEqual([{ level: 28, kind: 'flameup' }])
})

test('the level-up rung moves a level 2 flame to the new look', async () => {
  const { userId, run } = await clearLevelUp(56, { goldActive: true, flameTier: 4 })
  expect(run.flameTier).toBe(8)
  expect(await bestTier(userId)).toBe(8)
})

test('a flame past the top tier keeps the top look', async () => {
  const { run } = await clearLevelUp(392, { goldActive: true, flameTier: 52 })
  expect(run.flameTier).toBe(FLAME_TOP_TIER)
})

test('the best tier never drops', async () => {
  const userId = await mkUser(27)
  await prisma.user.update({ where: { id: userId }, data: { bestFlameTier: 16 } })
  await mkStreak(userId, { rewardLevel: 27, goldActive: true })
  await bothCleared(userId)
  await evaluateQuestStreaks({ models: prisma, userIds: [userId] })
  expect(await bestTier(userId)).toBe(16)
})

test('day 4 leaves a level 2 flame alone', async () => {
  const { run } = await clearLevelUp(32, { goldActive: true, flameTier: 4 })
  expect(run.goldActive).toBe(true)
  expect(run.flameTier).toBe(4)
})

test('level 2 absorbs two missed days, then the run ends, and the best tier survives', async () => {
  notifyShieldUsed.mockClear()
  const userId = await mkUser(30)
  await prisma.user.update({ where: { id: userId }, data: { bestFlameTier: 4 } })
  const run = await mkStreak(userId, { rewardLevel: 30, goldActive: true })
  await prisma.streak.update({ where: { id: run.id }, data: { flameTier: 4 } })
  const evaluate = days => evaluateQuestStreaks({ models: prisma, now: new Date(Date.now() + days * 86_400_000), userIds: [userId] })

  await evaluate(0)
  let row = await prisma.streak.findUnique({ where: { id: run.id } })
  expect(row).toMatchObject({ goldActive: true, flameTier: null, endedAt: null })
  expect(notifyShieldUsed).toHaveBeenLastCalledWith(userId, expect.objectContaining({ decayed: true }))

  await evaluate(1)
  row = await prisma.streak.findUnique({ where: { id: run.id } })
  expect(row).toMatchObject({ goldActive: false, flameTier: null, endedAt: null })
  expect(notifyShieldUsed.mock.lastCall[1].decayed).toBeUndefined()

  await evaluate(2)
  row = await prisma.streak.findUnique({ where: { id: run.id } })
  expect(row.endedAt).not.toBeNull()
  expect(await bestTier(userId)).toBe(4)
})

// --- scheduled-retry safety (2026-10-12 incident): pg-boss now
// redelivers the nightly evaluation (retryLimit 3, anchored to the job's
// original creation day). Every real-DB regression below is scoped to its own
// fixtures and proves a redelivery can neither double-settle a day that
// already committed nor lose a day whose transaction rolled back ---

test('a scoped retry cannot consume a shield twice', async () => {
  notifyShieldUsed.mockClear()
  const userId = await mkUser(4)
  const streak = await mkStreak(userId, { goldActive: true })
  const options = { models: prisma, userIds: [userId] }
  await evaluateQuestStreaks(options)
  await evaluateQuestStreaks(options)
  const after = await prisma.streak.findUnique({ where: { id: streak.id } })
  expect(after.goldActive).toBe(false)
  expect(after.endedAt).toBeNull()
  expect(notifyShieldUsed).toHaveBeenCalledTimes(1)
})

test('a partial run settles the committed user once and the rest on retry', async () => {
  notifyFlameAdvanced.mockClear()
  const userA = await mkUser(1)
  const streakA = await mkStreak(userA, { rewardLevel: 1 })
  const userB = await mkUser(1)
  const streakB = await mkStreak(userB, { rewardLevel: 1 })
  await bothCleared(userA)
  await bothCleared(userB)
  const dayDate = new Date(`${yesterday}T00:00:00.000Z`)

  // One-shot failure on the marker write of whichever fixture user is settled
  // second: the first user's day commits, the second user's transaction rolls
  // back whole — no marker, no grants, no publication.
  const fixtureStreaks = new Set([streakA.id, streakB.id])
  const markerWrites = new Set()
  let injected = false
  const faulty = prisma.$extends({
    query: {
      streak: {
        async update ({ args, query }) {
          const isMarker = args.data?.lastEvaluatedDay != null && fixtureStreaks.has(args.where.id)
          if (isMarker && markerWrites.size > 0 && !injected) {
            injected = true
            throw new Error('injected retry-safety failure')
          }
          const result = await query(args)
          if (isMarker) markerWrites.add(args.where.id)
          return result
        }
      }
    }
  })

  await expect(evaluateQuestStreaks({ models: faulty, userIds: [userA, userB] }))
    .rejects.toThrow('injected retry-safety failure')
  expect(injected).toBe(true)
  expect(markerWrites.size).toBe(1)

  const states = await prisma.streak.findMany({ where: { id: { in: [streakA.id, streakB.id] } } })
  const committed = states.filter(s => s.lastEvaluatedDay?.getTime() === dayDate.getTime())
  const rolledBack = states.filter(s => s.lastEvaluatedDay == null)
  expect(committed).toHaveLength(1)
  expect(rolledBack).toHaveLength(1)
  const committedUser = committed[0].userId
  const failedUser = rolledBack[0].userId

  // the rolled-back attempt left no trace: no count, no ladder row, no push
  const [failedRow] = await prisma.$queryRaw`SELECT streak FROM users WHERE id = ${failedUser}::int`
  expect(failedRow.streak).toBe(1)
  expect(await prisma.streakReward.count({ where: { userId: failedUser } })).toBe(0)
  expect(notifyFlameAdvanced.mock.calls.filter(([id]) => id === failedUser)).toHaveLength(0)
  expect(notifyFlameAdvanced.mock.calls.filter(([id]) => id === committedUser)).toHaveLength(1)

  // the retry settles only the outstanding user and never re-grants for the
  // already-committed one
  await evaluateQuestStreaks({ models: prisma, userIds: [userA, userB] })
  for (const id of [userA, userB]) {
    const [row] = await prisma.$queryRaw`SELECT streak FROM users WHERE id = ${id}::int`
    expect(row.streak).toBe(2)
    expect(await prisma.streakReward.count({ where: { userId: id, type: 'BOOST' } })).toBe(1)
    expect(notifyFlameAdvanced.mock.calls.filter(([callId]) => callId === id)).toHaveLength(1)
  }
  const after = await prisma.streak.findMany({ where: { id: { in: [streakA.id, streakB.id] } } })
  for (const s of after) {
    expect(s.lastEvaluatedDay.getTime()).toBe(dayDate.getTime())
    expect(s.rewardLevel).toBe(2)
  }
  // the committed user's ladder reward count is unchanged by the retry
  expect(await prisma.streakReward.count({ where: { userId: committedUser } })).toBe(1)
})

test('an allowlisted user with no rows is a no-op', async () => {
  notifyFlameAdvanced.mockClear()
  const missing = 2_000_000_000
  await expect(evaluateQuestStreaks({ models: prisma, userIds: [missing] })).resolves.toBeUndefined()
  expect(await prisma.streak.count({ where: { userId: missing } })).toBe(0)
  expect(await prisma.streakReward.count({ where: { userId: missing } })).toBe(0)
  expect(notifyFlameAdvanced).not.toHaveBeenCalled()
})
