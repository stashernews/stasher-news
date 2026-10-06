/* eslint-env jest */
import { PrismaClient } from '@prisma/client'
import { incrementFreeCommentCount } from '@/api/payIn/lib/freebie'
import { commentQuotaFor } from '@/api/monero/postingFee'

// Real-DB behavior test for the consumption side of banked REPLY credits:
// an over-base freebie comment eats one banked credit (soonest-expiring
// first); a stale prospect whose credit was already spent fails CLOSED
// ('no free comments left') so the caller's payIn transaction rolls the free
// item back; and the base window is spent before any credit. Mirrors the
// test/worker/quests.test.js fixture style: DEFAULT-VALUES users with tracked
// cleanup.
const prisma = new PrismaClient()
const created = { users: [], items: [] }

async function mkUser () {
  const [row] = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(row.id)
  return row.id
}

afterAll(async () => {
  await prisma.streakReward.deleteMany({ where: { userId: { in: created.users } } })
  await prisma.item.deleteMany({ where: { id: { in: created.items } } })
  await prisma.user.deleteMany({ where: { id: { in: created.users } } })
  await prisma.$disconnect()
})

test('a comment beyond the daily base consumes one REPLY credit, soonest-expiring first', async () => {
  const userId = await mkUser()
  const [root] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", title, created_at) VALUES (${userId}::int, 'rc root', now()) RETURNING id::int AS id`
  const [comment] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", "parentId", "rootId", text, created_at, freebie) VALUES (${userId}::int, ${root.id}::int, ${root.id}::int, 'rc reply', now(), true) RETURNING id::int AS id`
  created.items.push(root.id, comment.id)
  // base exhausted today
  await prisma.$executeRaw`UPDATE users SET "freeCommentCount" = 1, "freeCommentResetAt" = now() + interval '1 day' WHERE id = ${userId}::int`
  // two credits, the sooner-expiring one must go first
  await prisma.$executeRaw`INSERT INTO "StreakReward" ("userId", "grantedAt", "expiresAt", "type") VALUES (${userId}::int, now_utc(), now_utc() + interval '2 days', 'REPLY')`
  await prisma.$executeRaw`INSERT INTO "StreakReward" ("userId", "grantedAt", "expiresAt", "type") VALUES (${userId}::int, now_utc(), now_utc() + interval '20 days', 'REPLY')`

  await prisma.$transaction(tx => incrementFreeCommentCount(tx, { item: { freebie: true, parentId: root.id }, userId }))

  const consumed = await prisma.$queryRaw`SELECT "expiresAt" FROM "StreakReward" WHERE "userId" = ${userId}::int AND "consumedAt" IS NOT NULL`
  expect(consumed).toHaveLength(1)
  const soonest = new Date(Date.now() + 2 * 86_400_000)
  expect(new Date(consumed[0].expiresAt).getTime()).toBeLessThan(soonest.getTime() + 3_600_000)

  // a second over-base comment consumes the next credit, not the same one
  const [comment2] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", "parentId", "rootId", text, created_at, freebie) VALUES (${userId}::int, ${root.id}::int, ${root.id}::int, 'rc reply 2', now(), true) RETURNING id::int AS id`
  created.items.push(comment2.id)
  await prisma.$transaction(tx => incrementFreeCommentCount(tx, { item: { freebie: true, parentId: root.id }, userId }))
  expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY', consumedAt: { not: null } } })).toBe(2)
  // and a third has no credit left: the over-base freebie fails CLOSED — the
  // caller's payIn transaction rejects and rolls the item back rather than
  // committing a free comment nothing paid for
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await expect(prisma.$transaction(tx => incrementFreeCommentCount(tx, { item: { freebie: true, parentId: root.id }, userId })))
      .rejects.toThrow('no free comments left')
    expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY', consumedAt: { not: null } } })).toBe(2)
    expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY', consumedAt: null } })).toBe(0)
    // expected quota exhaustion is not logged as an unexpected failure
    expect(errorSpy).not.toHaveBeenCalled()
  } finally {
    errorSpy.mockRestore()
  }
})

test('a REPLY credit is spent only after the weekly base (base-first, credit preserved)', async () => {
  const userId = await mkUser()
  const [root] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", title, created_at) VALUES (${userId}::int, 'rc base root', now()) RETURNING id::int AS id`
  created.items.push(root.id)
  // a live weekly window with the base unspent, plus one banked credit
  await prisma.$executeRaw`UPDATE users SET "freeCommentCount" = 0, "freeCommentResetAt" = now() + interval '3 days' WHERE id = ${userId}::int`
  await prisma.$executeRaw`INSERT INTO "StreakReward" ("userId", "grantedAt", "expiresAt", "type") VALUES (${userId}::int, now_utc(), now_utc() + interval '2 days', 'REPLY')`

  await prisma.$transaction(tx => incrementFreeCommentCount(tx, { item: { freebie: true, parentId: root.id }, userId }))

  const user = await prisma.user.findUnique({ where: { id: userId } })
  expect(user.freeCommentCount).toBe(1)
  expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY', consumedAt: { not: null } } })).toBe(0)
})

test('a stale weekly window re-baselines and still preserves the held REPLY credit', async () => {
  const userId = await mkUser()
  const [root] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", title, created_at) VALUES (${userId}::int, 'rc stale root', now()) RETURNING id::int AS id`
  created.items.push(root.id)
  await prisma.$executeRaw`UPDATE users SET "freeCommentCount" = 3, "freeCommentResetAt" = now() - interval '1 day' WHERE id = ${userId}::int`
  await prisma.$executeRaw`INSERT INTO "StreakReward" ("userId", "grantedAt", "expiresAt", "type") VALUES (${userId}::int, now_utc(), now_utc() + interval '2 days', 'REPLY')`

  await prisma.$transaction(tx => incrementFreeCommentCount(tx, { item: { freebie: true, parentId: root.id }, userId }))

  const user = await prisma.user.findUnique({ where: { id: userId } })
  expect(user.freeCommentCount).toBe(1) // never accumulates
  expect(new Date(user.freeCommentResetAt).getTime()).toBeGreaterThan(Date.now())
  expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY', consumedAt: { not: null } } })).toBe(0)
})

test('an EXPIRED banked credit does not underwrite a free comment: reject, leave it unconsumed', async () => {
  const userId = await mkUser()
  const [root] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", title, created_at) VALUES (${userId}::int, 'rc expired root', now()) RETURNING id::int AS id`
  created.items.push(root.id)
  await prisma.$executeRaw`UPDATE users SET "freeCommentCount" = 1, "freeCommentResetAt" = now() + interval '1 day' WHERE id = ${userId}::int`
  await prisma.$executeRaw`INSERT INTO "StreakReward" ("userId", "grantedAt", "expiresAt", "type") VALUES (${userId}::int, now_utc() - interval '2 days', now_utc() - interval '1 day', 'REPLY')`

  await expect(prisma.$transaction(tx => incrementFreeCommentCount(tx, { item: { freebie: true, parentId: root.id }, userId })))
    .rejects.toThrow('no free comments left')
  expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY', consumedAt: { not: null } } })).toBe(0)
})

test('two concurrent stale prospects that both saw the last REPLY credit: exactly one commits', async () => {
  const userId = await mkUser()
  const [root] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", title, created_at) VALUES (${userId}::int, 'rc race root', now()) RETURNING id::int AS id`
  created.items.push(root.id)
  await prisma.$executeRaw`UPDATE users SET "freeCommentCount" = 1, "freeCommentResetAt" = now() + interval '1 day' WHERE id = ${userId}::int`
  await prisma.$executeRaw`INSERT INTO "StreakReward" ("userId", "grantedAt", "expiresAt", "type") VALUES (${userId}::int, now_utc(), now_utc() + interval '2 days', 'REPLY')`

  // the creation-time prospect runs BEFORE payIn's payer lock: both requests
  // legitimately price themselves free off the same visible credit. Call with
  // the full user row, exactly as getInitial does.
  const fullUser = await prisma.user.findUnique({ where: { id: userId } })
  const [q1, q2] = await Promise.all([
    commentQuotaFor(prisma, fullUser),
    commentQuotaFor(prisma, fullUser)
  ])
  expect(q1.left).toBe(1)
  expect(q2.left).toBe(1)

  // the locked consumption (payIn begin's record lock, then the increment)
  const attempt = () => prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::int FOR NO KEY UPDATE`
    await incrementFreeCommentCount(tx, { item: { freebie: true, parentId: root.id }, userId })
  })
  const results = await Promise.allSettled([attempt(), attempt()])
  const fulfilled = results.filter(r => r.status === 'fulfilled')
  const rejected = results.filter(r => r.status === 'rejected')
  expect(fulfilled).toHaveLength(1)
  expect(rejected).toHaveLength(1)
  expect(String(rejected[0].reason.message)).toContain('no free comments left')
  // exactly one credit was spent; the loser's rollback left nothing behind
  expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY', consumedAt: { not: null } } })).toBe(1)
  expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY', consumedAt: null } })).toBe(0)
})
