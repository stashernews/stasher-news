/* eslint-env jest */

// DB test for the promotional boost ranking storage (spec
// 2026-10-05-quest-rebalance-boost-credit, task 2). Item.promoBoostPiconeros
// must rank through item_ranking_trigger with the SAME weight as a paid
// boost — otherwise-identical items must land on identical ranktop/ranklit
// lit state — while leaving every monetary/rank-accounting field untouched.
// The UPDATE OF column list must fire on promo writes so the search indexing
// job is enqueued for the item.
//
// Requires a live, migrated database. Run via:
//   docker exec -i -w /app -u apprunner app npm run test -- test/prisma/boost-credit-ranking.test.js

import { PrismaClient, Prisma } from '@prisma/client'

const prisma = new PrismaClient()

// Fixture bookkeeping, scoped to this suite's rows only (same convention as
// test/api/payIn/boost.test.js): every seeded id lands in fixtureItemIds and
// is deleted in afterAll; pgboss jobs are cleaned up by fixture item id only.
const fixtureItemIds = []
let fixtureUserId
// UPDATE-branch twins from zero: paid boost vs promo boost
const litTwins = {}
// INSERT-branch twins: boost vs promoBoostPiconeros seeded in the INSERT
const insertTwins = {}
// UPDATE-branch twins from a non-zero baseline (second promo increment)
const secondTwins = {}
// promo-only invariants fixture
let invariantId

// The promo step everywhere in this suite: +500000000 (0.0005 XMR), matching
// the paid-boost step the comparisons are made against.
const STEP = 500000000
const SECOND_STEP = 250000000

const RANK_FIELDS = ['ranktop', 'ranklit', 'litCenteredSum', 'litCenteredAt']
// promo writes must not move any of these (exact before/after equality)
const INVARIANT_FIELDS = [
  'boost', 'commentBoost', 'piconeros', 'netInvestment',
  'weightedVotes', 'weightedDownVotes', 'feeInvestmentPiconeros'
]

// Two otherwise-identical root posts from ONE INSERT: identical columns, the
// same explicit created_at, zero lit state (fresh rows), and explicit fixture
// paths (the item_path BEFORE INSERT trigger derives path = id for roots).
async function seedTwinPair (paidBoost, promoBoost) {
  const rows = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", title, "created_at", boost, "promoBoostPiconeros")
    VALUES (${fixtureUserId}::int, 'promo ranking twin paid', '2026-10-05T00:00:00Z'::timestamptz, ${paidBoost}::bigint, 0::bigint),
           (${fixtureUserId}::int, 'promo ranking twin promo', '2026-10-05T00:00:00Z'::timestamptz, 0::bigint, ${promoBoost}::bigint)
    RETURNING id::int AS id, title`
  const paid = rows.find(r => r.title === 'promo ranking twin paid')
  const promo = rows.find(r => r.title === 'promo ranking twin promo')
  fixtureItemIds.push(paid.id, promo.id)
  // ids are assigned in VALUES order — pin the ORDER BY id pairing assumption
  expect(paid.id).toBeLessThan(promo.id)
  return { paidId: paid.id, promoId: promo.id }
}

async function seedSinglePost (title) {
  const rows = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", title, "created_at")
    VALUES (${fixtureUserId}::int, ${title}, '2026-10-05T00:00:00Z'::timestamptz)
    RETURNING id::int AS id`
  fixtureItemIds.push(rows[0].id)
  return rows[0].id
}

// the shared before/after reader for the promo-only invariants test
const readInvariants = (id) => prisma.$queryRaw`
  SELECT boost::bigint AS boost, "commentBoost"::bigint AS "commentBoost",
         piconeros::bigint AS piconeros, "netInvestment"::bigint AS "netInvestment",
         "weightedVotes"::float8 AS "weightedVotes",
         "weightedDownVotes"::float8 AS "weightedDownVotes",
         "feeInvestmentPiconeros"::bigint AS "feeInvestmentPiconeros",
         ranktop::float8 AS ranktop
  FROM "Item" WHERE id = ${id}::int`

beforeAll(async () => {
  const users = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  fixtureUserId = users[0].id

  // lit-state twins: identical rank inputs, zero lit state, explicit paths
  Object.assign(litTwins, await seedTwinPair(0, 0))
  const seeds = await prisma.$queryRaw`
    SELECT id::int AS id, path::text AS path, "litCenteredSum"::float8 AS "litCenteredSum",
           "litCenteredAt"::float8 AS "litCenteredAt"
    FROM "Item" WHERE id IN (${litTwins.paidId}::int, ${litTwins.promoId}::int)`
  for (const row of seeds) {
    expect(row.path).toBe(String(row.id))
    expect(row.litCenteredSum).toBe(0)
    expect(row.litCenteredAt).toBe(0)
  }

  invariantId = await seedSinglePost('promo invariants fixture')
})

afterAll(async () => {
  // cleanup scoped to fixture ids only: pgboss jobs by item id, then rows
  if (fixtureItemIds.length > 0) {
    await prisma.$executeRaw`DELETE FROM pgboss.job WHERE data->>'id' IN (${Prisma.join(fixtureItemIds.map(String))})`
    await prisma.item.deleteMany({ where: { id: { in: fixtureItemIds } } })
  }
  if (fixtureUserId) {
    await prisma.user.deleteMany({ where: { id: fixtureUserId } })
  }
  await prisma.$disconnect()
})

// The brief's exact lit-state comparison: one transaction applies the paid
// boost to one twin and the promo boost to the other, so the trigger's
// EXTRACT(EPOCH FROM now()) lit anchor is the same for both rows.
test('promo boost ranks identically to a paid boost from zero (UPDATE branch)', async () => {
  await prisma.$transaction(async tx => {
    await tx.$executeRaw`UPDATE "Item" SET boost = boost + 500000000 WHERE id = ${litTwins.paidId}::INTEGER`
    await tx.$executeRaw`UPDATE "Item" SET "promoBoostPiconeros" = "promoBoostPiconeros" + 500000000 WHERE id = ${litTwins.promoId}::INTEGER`
    const rows = await tx.$queryRaw`SELECT id, ranktop, ranklit, "litCenteredSum", "litCenteredAt" FROM "Item" WHERE id IN (${litTwins.paidId}::INTEGER, ${litTwins.promoId}::INTEGER) ORDER BY id`
    for (const field of RANK_FIELDS) {
      expect(rows[0][field]).toBeCloseTo(rows[1][field], 8)
    }
  })
  // anchor the pairwise equality to real values, not two zeros
  const rows = await prisma.$queryRaw`
    SELECT ranktop::float8 AS ranktop, ranklit::float8 AS ranklit,
           "litCenteredSum"::float8 AS "litCenteredSum", "litCenteredAt"::float8 AS "litCenteredAt"
    FROM "Item" WHERE id IN (${litTwins.paidId}::int, ${litTwins.promoId}::int) ORDER BY id`
  expect(rows[0].ranktop).toBe(STEP)
  expect(rows[0].litCenteredSum).toBe(STEP)
  expect(rows[0].litCenteredAt).toBeGreaterThan(0)
  expect(rows[0].ranklit).toBeGreaterThan(0)
})

// A promo write is rank-only: no money, no comment-weight, no investment or
// vote bookkeeping moves. ranktop rises by exactly the promo amount, and the
// ranking trigger's UPDATE OF list fired (search indexing job enqueued).
test('promo-only update leaves monetary fields untouched and raises ranktop by exactly 500000000', async () => {
  const before = await readInvariants(invariantId)
  await prisma.$executeRaw`UPDATE "Item" SET "promoBoostPiconeros" = "promoBoostPiconeros" + 500000000 WHERE id = ${invariantId}::int`
  const after = await readInvariants(invariantId)
  for (const field of INVARIANT_FIELDS) {
    expect(after[0][field]).toBe(before[0][field])
  }
  expect(after[0].ranktop - before[0].ranktop).toBe(STEP)

  const jobs = await prisma.$queryRaw`
    SELECT name FROM pgboss.job WHERE name = 'indexItem' AND data->>'id' = ${String(invariantId)}`
  expect(jobs.length).toBeGreaterThan(0)
})

// INSERT twins: the trigger's INSERT branch must weight a seeded promo term
// exactly like a seeded paid term.
test('promo boost ranks identically to a paid boost seeded in the INSERT (INSERT branch)', async () => {
  Object.assign(insertTwins, await seedTwinPair(STEP, STEP))
  const rows = await prisma.$queryRaw`
    SELECT id, ranktop, ranklit, "litCenteredSum", "litCenteredAt"
    FROM "Item" WHERE id IN (${insertTwins.paidId}::INTEGER, ${insertTwins.promoId}::INTEGER) ORDER BY id`
  expect(rows.map(r => r.id)).toEqual([insertTwins.paidId, insertTwins.promoId])
  for (const field of RANK_FIELDS) {
    expect(rows[0][field]).toBeCloseTo(rows[1][field], 8)
  }
  expect(rows[0].ranktop).toBe(STEP)
  expect(rows[0].litCenteredSum).toBe(STEP)
})

// Second promo increment: the UPDATE delta branch from a non-zero baseline
// must still track a same-sized paid boost increment.
test('a second promo increment ranks identically to a second paid increment (non-zero baseline)', async () => {
  Object.assign(secondTwins, await seedTwinPair(STEP, STEP))
  const baseline = await prisma.$queryRaw`
    SELECT ranktop::float8 AS ranktop FROM "Item"
    WHERE id IN (${secondTwins.paidId}::int, ${secondTwins.promoId}::int) ORDER BY id`
  expect(baseline[0].ranktop).toBe(STEP)
  expect(baseline[1].ranktop).toBe(STEP)

  await prisma.$transaction(async tx => {
    await tx.$executeRaw`UPDATE "Item" SET boost = boost + 250000000 WHERE id = ${secondTwins.paidId}::INTEGER`
    await tx.$executeRaw`UPDATE "Item" SET "promoBoostPiconeros" = "promoBoostPiconeros" + 250000000 WHERE id = ${secondTwins.promoId}::INTEGER`
    const rows = await tx.$queryRaw`SELECT id, ranktop, ranklit, "litCenteredSum", "litCenteredAt" FROM "Item" WHERE id IN (${secondTwins.paidId}::INTEGER, ${secondTwins.promoId}::INTEGER) ORDER BY id`
    for (const field of RANK_FIELDS) {
      expect(rows[0][field]).toBeCloseTo(rows[1][field], 8)
    }
  })
  const after = await prisma.$queryRaw`
    SELECT ranktop::float8 AS ranktop FROM "Item"
    WHERE id IN (${secondTwins.paidId}::int, ${secondTwins.promoId}::int) ORDER BY id`
  expect(after[0].ranktop).toBe(STEP + SECOND_STEP)
  expect(after[1].ranktop).toBe(STEP + SECOND_STEP)
})
