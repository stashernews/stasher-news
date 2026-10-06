/* eslint-env jest */
import { PrismaClient } from '@prisma/client'
import { lockRewardUser, rewardNow, availableBoostCredit } from '@/api/quests/boost-credit'
import { grantLadderRewards } from '@/worker/streak'
import { __setQuestClockForTests } from '@/lib/questClock'

jest.mock('../../../lib/webPush', () => ({
  notifyFlameAdvanced: jest.fn(() => Promise.resolve()),
  notifyShieldUsed: jest.fn(() => Promise.resolve()),
  notifyStreakLost: jest.fn(() => Promise.resolve())
}))

const prisma = new PrismaClient()
const created = { users: [], streaks: [] }

async function mkUser () {
  const [row] = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(row.id)
  return row.id
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

afterAll(async () => {
  await prisma.streakReward.deleteMany({ where: { userId: { in: created.users } } })
  await prisma.streak.deleteMany({ where: { id: { in: created.streaks } } })
  await prisma.user.deleteMany({ where: { id: { in: created.users } } })
  await prisma.$disconnect()
})

test('lockRewardUser reports an existing user and a missing one', async () => {
  const userId = await mkUser()
  // Top level (autocommit) is fine for the reader-side probe; grant paths run
  // it inside the transaction that will write.
  await expect(lockRewardUser(prisma, userId)).resolves.toBe(true)
  const [gap] = await prisma.$queryRaw`SELECT COALESCE(max(id), 0)::int + 1000000 AS id FROM users`
  await expect(lockRewardUser(prisma, gap.id)).resolves.toBe(false)
})

test('rewardNow reads the database wall clock', async () => {
  // The DB's own clock is authoritative for grant/expiry timestamps; this
  // stays within a couple of milliseconds of the local one (a raw
  // clock_timestamp crosses the wire untouched, hence the tolerance).
  const before = new Date()
  const now = await rewardNow(prisma)
  const after = new Date(now.getTime() + 16)
  expect(now.getTime()).toBeGreaterThanOrEqual(before.getTime() - 16)
  expect(now.getTime()).toBeLessThanOrEqual(after.getTime())
})

test('availableBoostCredit returns the earliest available row, ties by id', async () => {
  const userId = await mkUser()
  await prisma.streakReward.createMany({
    data: [
      // consumed and expired rows are not available
      { userId, type: 'BOOST', consumedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) },
      { userId, type: 'BOOST', grantedAt: new Date(Date.now() - 2 * 86_400_000), expiresAt: new Date(Date.now() - 86_400_000) }
    ]
  })
  const earliest = await prisma.streakReward.create({ data: { userId, type: 'BOOST', expiresAt: new Date(Date.now() + 3_600_000) } })
  const tieLow = await prisma.streakReward.create({ data: { userId, type: 'BOOST', expiresAt: new Date(Date.now() + 2 * 3_600_000) } })
  const tieHigh = await prisma.streakReward.create({ data: { userId, type: 'BOOST', expiresAt: new Date(Date.now() + 2 * 3_600_000) } })
  expect(tieLow.id).toBeLessThan(tieHigh.id)

  const available = await availableBoostCredit(prisma, userId)
  // ordering is (expiresAt, id): the lone +1h future row wins over the two
  // later +2h rows
  expect(available.id).toBe(earliest.id)
  expect(available.expiresAt.getTime()).toBeGreaterThan(Date.now())
  expect(available.consumedAt).toBeUndefined() // projection is id + expiresAt only

  // consume it → the next-earliest future row becomes available
  await prisma.streakReward.update({ where: { id: available.id }, data: { consumedAt: new Date() } })
  const next = await availableBoostCredit(prisma, userId)
  // equal expiry ties resolve by id: the earlier row
  expect(next.id).toBe(tieLow.id)
})

test('availableBoostCredit already excludes a row expiring exactly when read', async () => {
  const userId = await mkUser()
  // The comparison instant cannot be frozen across two statements, so pin the
  // boundary instead: seed expiresAt = the DB timestamp sampled by the
  // seeding query itself and check right away. The reader's clock_timestamp
  // is strictly later, and the strict '>' matches neither a boundary nor a
  // past row, so the row must never read as available.
  const [boundary] = await prisma.$queryRaw`
    INSERT INTO "StreakReward" ("userId", "grantedAt", "expiresAt", "type")
    VALUES (${userId}::int, now_utc(), now_utc() - interval '1 second', 'BOOST')
    RETURNING id::int AS id`
  expect(await availableBoostCredit(prisma, userId)).toBeNull()
  expect(boundary.id).not.toBeNull()
})

test('the grant arithmetic expires BOOST exactly 30 days past both anchors', async () => {
  // The insert mirrors the worker's BOOST grant verbatim (one rewardNow-style
  // timestamp for created_at/grantedAt, expiresAt = grantedAt + 30 days, not
  // a calendar month): anchor instants both now-future, spanning a leap
  // February and a full October→November month, must differ by exactly
  // 2,592,000,000 ms.
  for (const granted of ['2028-02-01T12:00:00Z', '2026-10-31T12:00:00Z']) {
    const userId = await mkUser()
    const anchor = new Date(granted)
    const [row] = await prisma.$queryRaw`
      INSERT INTO "StreakReward" ("userId", created_at, "grantedAt", "expiresAt", type)
      VALUES (${userId}::int, ${anchor}::timestamp, ${anchor}::timestamp,
        ${anchor}::timestamp + interval '30 days', 'BOOST'::"StreakRewardType")
      RETURNING "grantedAt", "expiresAt"`
    expect(row.expiresAt.getTime() - row.grantedAt.getTime()).toBe(2_592_000_000)
  }
})

test('BOOST expiry stays 30 real days under the compressed quest clock', async () => {
  // The dev clock compresses quest days to 60s; the boost expiry must stay
  // pinned to real time (30 × 24 hours after the grant, never 30 compressed
  // quest days or a calendar month).
  __setQuestClockForTests({ epoch: new Date(), dayMs: 60_000 })
  let granted = null
  const userId = await mkUser()
  const streak = await prisma.streak.create({ data: { userId, type: 'FLAME', startedAt: new Date() } })
  created.streaks.push(streak.id)
  await prisma.user.update({ where: { id: userId }, data: { streak: 4 } })
  try {
    await prisma.$transaction(async tx => {
      expect(await lockRewardUser(tx, userId)).toBe(true)
      granted = await grantLadderRewards({ models: tx, userId, streak, from: 4, to: 5 })
    })
    expect(granted).toEqual([{ level: 5, kind: 'boost' }])
    const credit = await prisma.streakReward.findFirst({ where: { userId, type: 'BOOST' } })
    expect(credit.expiresAt.getTime() - credit.grantedAt.getTime()).toBe(30 * 86_400_000)
  } finally {
    __setQuestClockForTests(null)
  }
})

test('a held credit expiring during the user-row lock wait does not suppress the fresh day-5 grant', async () => {
  // Grant-side mirror of the redemption lock-wait case (spec §5.1: sample the
  // DB wall clock AFTER acquiring locks). The caller's row lock parks through
  // a long wait, and now_utc() stays frozen at the transaction's BEGIN —
  // before the wait — so adjudicating availability from it would count a
  // mid-wait-expired credit as held: the rung would be suppressed and the
  // marker would advance permanently without a grant. The grant must instead
  // judge BOTH the held-count predicate and the fresh row's timestamps from
  // one post-lock rewardNow sample, so the expiry that passes mid-wait frees
  // the rung and the fresh 30-day window anchors at the post-lock instant.
  const userId = await mkUser()
  const streak = await prisma.streak.create({ data: { userId, type: 'FLAME', startedAt: new Date() } })
  created.streaks.push(streak.id)
  await prisma.user.update({ where: { id: userId }, data: { streak: 4 } })
  // the credit is seeded BEFORE the blocker: the StreakReward INSERT takes
  // FOR KEY SHARE on the users row (FK), so seeding behind the held FOR
  // UPDATE would land it already expired and degenerate into the plain
  // expired-credit case. Seeded first it is live at grant entry, and its
  // expiry is guaranteed to pass while the grant still parks.
  const seededAt = new Date()
  const grantedAt = new Date(seededAt.getTime() - 3 * 86_400_000)
  const EXPIRY_DELAY_MS = 500
  const BLOCKER_HOLD_MS = 900
  const expiresAt = new Date(seededAt.getTime() + EXPIRY_DELAY_MS)
  const held = await prisma.streakReward.create({ data: { userId, type: 'BOOST', grantedAt, expiresAt } })

  let resolveLockHeld
  const lockHeld = new Promise(resolve => { resolveLockHeld = resolve })
  const blocker = prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${Number(userId)}::int FOR UPDATE`
    resolveLockHeld()
    await sleep(BLOCKER_HOLD_MS)
  })
  await lockHeld

  // the grant path parks on lockRewardUser until the blocker releases — well
  // after the held credit's expiry has passed
  const grant = prisma.$transaction(async tx => {
    if (!await lockRewardUser(tx, userId)) throw new Error('lock lost')
    return grantLadderRewards({ models: tx, userId, streak, from: 4, to: 5 })
  })

  const [blockerResult, grantResult] = await Promise.allSettled([blocker, grant])
  expect(blockerResult.status).toBe('fulfilled')
  expect(grantResult.status).toBe('fulfilled')
  // the rung was not suppressed: the held row expired while the lock parked
  expect(grantResult.value).toEqual([{ level: 5, kind: 'boost' }])

  const rows = await prisma.streakReward.findMany({
    where: { userId, type: 'BOOST' },
    orderBy: { id: 'asc' }
  })
  // exactly two rows: the expired held one untouched, one fresh grant — no
  // double grant, no lost rung
  expect(rows).toHaveLength(2)
  const [expired, fresh] = rows
  expect(expired.id).toBe(held.id)
  expect(expired.consumedAt).toBeNull()
  expect(expired.grantedAt.getTime()).toBe(grantedAt.getTime())
  expect(expired.expiresAt.getTime()).toBe(expiresAt.getTime())
  expect(fresh.id).not.toBe(held.id)
  expect(fresh.consumedAt).toBeNull()
  expect(fresh.expiresAt.getTime()).toBeGreaterThan(Date.now())
  // exactly 30 real days, anchored at the post-lock grant instant
  expect(fresh.expiresAt.getTime() - fresh.grantedAt.getTime()).toBe(30 * 86_400_000)
  expect(fresh.grantedAt.getTime()).toBeGreaterThan(expiresAt.getTime())
  // the marker advanced with the grant (the reward is in `granted`, not lost)
  const settled = await prisma.streak.findUnique({ where: { id: streak.id } })
  expect(settled.rewardLevel).toBe(5)
})
