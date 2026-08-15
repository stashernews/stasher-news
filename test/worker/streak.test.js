/* eslint-env jest */
import { checkStreak, computeStreaks } from '@/worker/streak'
import { PrismaClient } from '@prisma/client'

// A tagged-template call passes (stringsArray, ...values) to the mock; the
// interpolated getStreakQuery result is a Prisma.sql object carrying the
// real query text and parameters. Flatten both into a { text, values }
// shape so assertions can inspect the nested union query.
async function captureStreakQuery () {
  let captured
  const models = {
    user: { findUnique: async () => ({ streak: null }) },
    $queryRaw: async (...args) => {
      const [strings, ...values] = args
      let text = ''
      const flatValues = []
      strings.forEach((chunk, i) => {
        text += chunk
        const value = values[i]
        if (value == null) return
        if (typeof value === 'object' && value.text !== undefined) {
          text += value.text
          flatValues.push(...(value.values || []))
        } else {
          flatValues.push(value)
        }
      })
      captured = { text, values: flatValues }
      return []
    }
  }
  await checkStreak({ data: { id: 5, type: 'FLAME' }, models })
  return captured
}

test('requires BOTH paid actions and received tips for the streak (INTERSECT)', async () => {
  const sql = await captureStreakQuery()
  expect(sql.text).toContain('INTERSECT')
  expect(sql.text).toContain('ObservedTip')
  expect(sql.text).toContain('recipientAccountId')
  expect(sql.text).toContain('ownerUserId')
  expect(sql.text).not.toContain('tipperId')
  expect(sql.values).toContain(5)
})

test('paid actions count fee-pool payments via FeeObservation (POSTING/TERRITORY/DONATE/BOOST)', async () => {
  const sql = await captureStreakQuery()
  expect(sql.text).toContain('FeeObservation')
  expect(sql.text).toContain('JOIN "PayIn"')
  expect(sql.text).toContain('f."payInId" IS NOT NULL')
})

test('writes the FLAME streak type', async () => {
  const sql = await captureStreakQuery()
  expect(sql.values).toContain('FLAME')
})

test('thresholds a streak day at 0.001 XMR (1e9 piconeros)', async () => {
  const sql = await captureStreakQuery()
  expect(sql.values).toContain(1000000000)
})

test('skips users with an active streak', async () => {
  const models = {
    user: { findUnique: async () => ({ streak: 3 }) },
    $queryRaw: jest.fn()
  }
  await checkStreak({ data: { id: 5, type: 'FLAME' }, models })
  expect(models.$queryRaw).not.toHaveBeenCalled()
})

// Real-DB COIN streak lifecycle test (live migrated database, FK-safe teardown).
// Run via the app container:
//   docker exec -w /app -e NODE_OPTIONS=--experimental-vm-modules -u apprunner app npx jest test/worker/streak.test.js
const prisma = new PrismaClient()
let coinUserId

beforeAll(async () => {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  coinUserId = rows[0].id
  // The COIN lifecycle test resolves the tip recipient via
  // (SELECT id FROM "MoneroAccount" LIMIT 1) — on a fresh CI database no
  // account exists yet and that subquery returns NULL, failing the insert's
  // NOT NULL constraint. Seed one for our user (afterAll already deletes
  // MoneroAccount rows by ownerUserId). Mirrors the FLAME test's own-account
  // pattern below.
  await prisma.$executeRaw`
    INSERT INTO "MoneroAccount" ("ownerUserId", "address", "label", "network")
    VALUES (${coinUserId}::int, 'test-coin-addr-' || gen_random_uuid()::text, 'author', 'STAGENET'::"Network")`
})

afterAll(async () => {
  if (coinUserId) {
    // cleanup BEFORE the user delete: ObservedTip has no tipper FK guard,
    // FeeObservation RESTRICTs on payInId, MoneroAccount does not cascade
    // from users, and Streak cascades on the user delete
    await prisma.$executeRaw`
      DELETE FROM "ObservedTip"
      WHERE "tipperId" = ${coinUserId}::int
         OR "recipientAccountId" IN (SELECT id FROM "MoneroAccount" WHERE "ownerUserId" = ${coinUserId}::int)`
    await prisma.$executeRaw`
      DELETE FROM "FeeObservation"
      WHERE "payInId" IN (SELECT id FROM "PayIn" WHERE "userId" = ${coinUserId}::int)`
    await prisma.$executeRaw`DELETE FROM "MoneroAccount" WHERE "ownerUserId" = ${coinUserId}::int`
    await prisma.$executeRaw`DELETE FROM users WHERE id = ${coinUserId}::int`
  }
  await prisma.$disconnect()
})

async function seedCoinStreak () {
  const rows = await prisma.$queryRaw`
    INSERT INTO "Streak" ("userId", "startedAt", "type", created_at, updated_at)
    VALUES (${coinUserId}::int, now() - interval '2 days', 'COIN'::"StreakType", now_utc(), now_utc())
    RETURNING id::int AS id`
  return rows[0].id
}

test('computeStreaks ends a COIN streak after 24h without a tip', async () => {
  const streakId = await seedCoinStreak()

  await computeStreaks({ models: prisma })

  const row = await prisma.streak.findFirst({ where: { id: streakId } })
  expect(row.endedAt).toBeTruthy()
})

test('computeStreaks keeps a COIN streak alive within 24h of a DETECTED tip', async () => {
  const streakId = await seedCoinStreak()
  await prisma.$executeRaw`
    INSERT INTO "ObservedTip" ("txHash", "postId", "tipperId", "recipientAccountId", "paymentId", "piconeros", "state", "detectedAt")
    VALUES (
      'test-coin-keep-' || gen_random_uuid()::text,
      (SELECT id FROM "Item" LIMIT 1),
      ${coinUserId}::int,
      (SELECT id FROM "MoneroAccount" LIMIT 1),
      'test-coin-pid-' || gen_random_uuid()::text,
      1000000000,
      'DETECTED'::"ObservedState",
      now())`

  await computeStreaks({ models: prisma })

  const row = await prisma.streak.findFirst({ where: { id: streakId } })
  expect(row.endedAt).toBeNull()
})

test('computeStreaks starts a FLAME streak for a user who paid a fee AND received a tip', async () => {
  const [{ payInId }] = await prisma.$queryRaw`
    INSERT INTO "PayIn" ("userId", "payInType", "payInState", "payInStateChangedAt", piconeros)
    VALUES (${coinUserId}::int, 'ITEM_CREATE'::"PayInType", 'PAID'::"PayInState", now(), 0)
    RETURNING id::int AS "payInId"`
  await prisma.$executeRaw`
    INSERT INTO "FeeObservation" ("txHash", "payInId", "feeType", "recipientMajor", "recipientMinor", "piconeros", "state", "detectedAt")
    VALUES (
      'test-flame-fee-' || gen_random_uuid()::text,
      ${payInId},
      'POSTING'::"FeeType",
      1, 9000, 1000000000,
      'CONFIRMED'::"ObservedState",
      now())`
  const [{ accountId }] = await prisma.$queryRaw`
    INSERT INTO "MoneroAccount" ("ownerUserId", "address", "label", "network")
    VALUES (${coinUserId}::int, 'test-flame-addr-' || gen_random_uuid()::text, 'author', 'STAGENET'::"Network")
    RETURNING id::int AS "accountId"`
  await prisma.$executeRaw`
    INSERT INTO "ObservedTip" ("txHash", "postId", "tipperId", "recipientAccountId", "paymentId", "piconeros", "state", "detectedAt")
    VALUES (
      'test-flame-tip-' || gen_random_uuid()::text,
      (SELECT id FROM "Item" LIMIT 1),
      NULL,
      ${accountId},
      'test-flame-pid-' || gen_random_uuid()::text,
      1000000000,
      'DETECTED'::"ObservedState",
      now())`

  await computeStreaks({ models: prisma })

  const row = await prisma.streak.findFirst({ where: { userId: coinUserId, type: 'FLAME' } })
  expect(row).toBeTruthy()
  expect(row.endedAt).toBeNull()
  const user = await prisma.user.findUnique({ where: { id: coinUserId } })
  expect(user.streak).toBe(1)
})
