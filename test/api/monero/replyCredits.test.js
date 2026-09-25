/* eslint-env jest */
import { PrismaClient } from '@prisma/client'
import { incrementFreeCommentCount } from '@/api/payIn/lib/freebie'

// Real-DB behavior test for the consumption side of banked REPLY credits:
// an over-base freebie comment eats one banked credit (soonest-expiring
// first), and with no credit left nothing is consumed (the gate should not
// have granted the freebie). Mirrors the test/worker/quests.test.js fixture
// style: DEFAULT-VALUES users with tracked cleanup.
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
  // and a third has no credit left: nothing more is consumed
  const [comment3] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", "parentId", "rootId", text, created_at, freebie) VALUES (${userId}::int, ${root.id}::int, ${root.id}::int, 'rc reply 3', now(), true) RETURNING id::int AS id`
  created.items.push(comment3.id)
  await prisma.$transaction(tx => incrementFreeCommentCount(tx, { item: { freebie: true, parentId: root.id }, userId }))
  expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY', consumedAt: { not: null } } })).toBe(2)
})
