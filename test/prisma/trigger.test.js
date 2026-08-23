/* eslint-env jest */

// Integration test: verifies the item_ranking trigger (rewritten in
// migration 20260823124834_tip_rank_trigger_backfill) fires on the
// StasherNews baseline and updates ranktop/ranklit in response to
// tipRankPiconeros / downPiconeros changes. The trigger reads the CAPPED tip
// terms (tipRankPiconeros), NOT raw piconeros: updating raw piconeros alone
// fires the trigger (kept in the UPDATE OF list) but contributes nothing to
// ranktop/ranklit.
//
// Requires a live, migrated database. Run via:
//   ./sndev test test/prisma/trigger.test.js

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

let testUserId
let testItemId

afterAll(async () => {
  if (testItemId) {
    await prisma.$executeRaw`DELETE FROM "Item" WHERE id = ${testItemId}::int`
  }
  if (testUserId) {
    await prisma.$executeRaw`DELETE FROM users WHERE id = ${testUserId}::int`
  }
  await prisma.$disconnect()
})

async function insertUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  return rows[0].id
}

async function insertItem (userId) {
  const rows = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", title) VALUES (${userId}::int, 'trigger-test')
    RETURNING id::int AS id, ranktop::float8 AS ranktop, piconeros::bigint AS piconeros`
  return rows[0]
}

test('ranking trigger sets ranktop on INSERT from piconeros', async () => {
  testUserId = await insertUser()
  const row = await insertItem(testUserId)
  testItemId = row.id

  // fresh insert with piconeros default 0 → ranktop must be 0
  expect(Number(row.piconeros)).toBe(0)
  expect(row.ranktop).toBe(0)
})

test('ranking trigger recomputes ranktop on UPDATE OF tipRankPiconeros (not raw piconeros)', async () => {
  // ranktop = cost*1000 + tipRankPiconeros + boost + commentTipRankPiconeros*0.25 + ...
  //          - downPiconeros - commentDownPiconeros*0.1
  // raw piconeros is no longer a rank input: updating it alone must leave ranktop at 0
  await prisma.$executeRaw`UPDATE "Item" SET piconeros = 1000000 WHERE id = ${testItemId}::int`
  let rows = await prisma.$queryRaw`SELECT ranktop::float8 AS ranktop FROM "Item" WHERE id = ${testItemId}::int`
  expect(rows[0].ranktop).toBe(0)
  // with only tipRankPiconeros set to 1_000_000 and everything else 0 → ranktop == 1_000_000
  await prisma.$executeRaw`UPDATE "Item" SET "tipRankPiconeros" = 1000000 WHERE id = ${testItemId}::int`
  rows = await prisma.$queryRaw`SELECT ranktop::float8 AS ranktop FROM "Item" WHERE id = ${testItemId}::int`
  expect(rows[0].ranktop).toBe(1000000)
})

test('ranking trigger subtracts downPiconeros from ranktop', async () => {
  // tipRankPiconeros=1_000_000, downPiconeros=100_000 → ranktop = 1_000_000 - 100_000 = 900_000
  await prisma.$executeRaw`UPDATE "Item" SET "downPiconeros" = 100000 WHERE id = ${testItemId}::int`
  const rows = await prisma.$queryRaw`SELECT ranktop::float8 AS ranktop FROM "Item" WHERE id = ${testItemId}::int`
  expect(rows[0].ranktop).toBe(900000)
})

test('ranking trigger updates ranklit on tipRankPiconeros change', async () => {
  // after a non-zero tipRankPiconeros contribution, litCenteredSum > 0 ⇒ ranklit > 0
  const rows = await prisma.$queryRaw`SELECT ranklit::float8 AS ranklit, "litCenteredSum"::float8 AS lit FROM "Item" WHERE id = ${testItemId}::int`
  expect(rows[0].lit).toBeGreaterThan(0)
  expect(rows[0].ranklit).toBeGreaterThan(0)
})
