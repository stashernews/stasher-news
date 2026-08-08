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

test('counts P2P ObservedTip activity toward the streak (union branch)', async () => {
  const sql = await captureStreakQuery()
  expect(sql.text).toContain('ObservedTip')
  expect(sql.text).toContain('tipperId')
  expect(sql.values).toContain(5)
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
})

afterAll(async () => {
  if (coinUserId) await prisma.$executeRaw`DELETE FROM users WHERE id = ${coinUserId}::int`
  await prisma.$disconnect()
})

test('computeStreaks ends a COIN streak after 24h without a tip', async () => {
  await prisma.$executeRaw`
    INSERT INTO "Streak" ("userId", "startedAt", "type", created_at, updated_at)
    VALUES (${coinUserId}::int, now() - interval '2 days', 'COIN'::"StreakType", now_utc(), now_utc())`

  await computeStreaks({ models: prisma })

  const row = await prisma.streak.findFirst({ where: { userId: coinUserId, type: 'COIN' } })
  expect(row.endedAt).toBeTruthy()
})
