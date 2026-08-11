/* eslint-env jest */

// Integration test for worker/trust.js — verifies the trust graph reads from the
// live P2P observation tables (ObservedTip / ObservedDownvote), NOT the dead
// PayIn/ItemPayIn tables. The nightly trust job (pgboss 'trust', 0 2 * * * America/Chicago)
// consumes this graph to populate UserSubTrust per ACTIVE territory; Task 2 of the
// merged plan consumes UserSubTrust.zapPostTrust/etc. to weight live tips.
//
// The trust algorithm (unchanged upstream stacker.news logic) needs CRISS-CROSS
// co-voting to emit a trust edge: a single shared item leaves one of before/after
// NULL (sum() FILTER returns NULL over no matches), so b_total - after is NULL and
// confidence() is never called. The fixture below therefore criss-crosses each
// curator with the founder (a per-territory trust seed) across two posts so the
// seed "follows" the curator on one post and is "followed by" the curator on
// another — producing a real confidence() edge that propagates seed trust to the
// curator.
//
// Real DB integration mirroring test/worker/rewardsDistributor.test.js (live migrated
// database, FK-safe teardown). Run via the app container:
//   docker exec -u apprunner app npx jest test/worker/trust.test.js

import { PrismaClient } from '@prisma/client'
import { trust } from '@/worker/trust'
import { USER_ID } from '@/lib/constants'

const prisma = new PrismaClient()

// The global trust seed is the stasher user (USER_ID.untraceable = 616). For GLOBAL
// trust (zapPostTrust) to reach a curator, the seed must itself tip — the random
// walk restarts at the seed each iteration, so only nodes the seed "follows" accrue
// trust. This is exactly what the brief's RED note describes: before the rewire the
// seeded user contributed no edges (the dead PayIn table had no rows), so the
// curator's zapPostTrust stayed 0.
const SEED_USER = USER_ID.untraceable // 616

const AMOUNT_A = 1_000_000_000_000n // aId tips 1 XMR (-> confidence(1,1,Z) ≈ 0.207)
const AMOUNT_C = 2_000_000_000_000n // cId tips 2 XMR (-> confidence(0.5,1.5,Z) ≈ 0.036)
const AMOUNT_SEED = 1_000_000_000_000n // the seed tips 1 XMR
const DAY = 24 * 60 * 60 * 1000

let addrSeq = 0
function makeAddress () {
  addrSeq += 1
  return '5' + String(Date.now() % 100000).padStart(5, '0') + String(addrSeq) + 'A'.repeat(88)
}

const created = { users: [], items: [], accounts: [], tips: [], subs: [] }
const territoryName = `trust-turf-${process.pid}-${Date.now()}`

let founderId
let authorId
let aId
let cId

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(rows[0].id)
  return rows[0].id
}

async function mkPost () {
  const item = await prisma.item.create({
    data: { userId: authorId, title: 'trust graph post', subName: territoryName, status: 'ACTIVE' }
  })
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(item.id)}::ltree WHERE id = ${item.id}::int`
  created.items.push(item.id)
  return item.id
}

let tipSeq = 0
async function seedTip ({ postId, tipperId, piconeros, confirmedAt, recipientAccountId }) {
  tipSeq += 1
  const tip = await prisma.observedTip.create({
    data: {
      txHash: 'trusttip' + String(tipSeq),
      postId,
      tipperId,
      recipientAccountId,
      recipientMajor: 0,
      recipientMinor: tipSeq,
      paymentId: 'trust' + String(tipSeq).padStart(6, '0') + '0000000000',
      piconeros,
      height: 3000,
      confirmations: 10,
      state: 'CONFIRMED',
      proofType: 'INDEXED',
      confirmedAt
    }
  })
  created.tips.push(tip.id)
  return tip
}

// Seed a two-post criss-cross between `curator` and the global seed user: the
// curator tips first on post A (seed follows) and the seed tips first on post B
// (curator follows). This yields a non-null before/after pair and a real
// confidence() edge seed -> curator, propagating the seed's trust to the curator.
async function seedCrissCross ({ curatorId, curatorAmount, firstMinor, recipientAccountId, base }) {
  const postA = await mkPost()
  const postB = await mkPost()
  await seedTip({ postId: postA, tipperId: curatorId, piconeros: curatorAmount, confirmedAt: new Date(base + firstMinor * 60000), recipientAccountId })
  await seedTip({ postId: postA, tipperId: SEED_USER, piconeros: AMOUNT_SEED, confirmedAt: new Date(base + (firstMinor + 1) * 60000), recipientAccountId })
  await seedTip({ postId: postB, tipperId: SEED_USER, piconeros: AMOUNT_SEED, confirmedAt: new Date(base + (firstMinor + 2) * 60000), recipientAccountId })
  await seedTip({ postId: postB, tipperId: curatorId, piconeros: curatorAmount, confirmedAt: new Date(base + (firstMinor + 3) * 60000), recipientAccountId })
}

beforeAll(async () => {
  // Territory founder is a per-territory trust seed for the SUB walks
  // (seeds = GLOBAL_SEEDS ∪ {founderId}); it does not need to tip for the global
  // zapPostTrust assertion, which is driven by SEED_USER (stasher) tipping.
  founderId = await createUser()
  authorId = await createUser()
  aId = await createUser()
  cId = await createUser()

  await prisma.sub.create({
    data: {
      name: territoryName,
      userId: founderId,
      rankingType: 'WOT',
      billingType: 'ONCE',
      billingCost: 1_000_000_000,
      status: 'ACTIVE',
      billingStatus: 'PAID'
    }
  })
  created.subs.push(territoryName)

  // Author receiving account (ObservedTip.recipientAccountId FK). Every tipped post
  // is authored by `authorId`, distinct from every tipper (including the seed user).
  const recipient = await prisma.moneroAccount.create({
    data: { ownerUserId: authorId, address: makeAddress(), label: 'author', network: 'STAGENET', status: 'ACTIVE' }
  })
  created.accounts.push(recipient.id)

  const base = Date.now() - 3 * DAY
  // aId's criss-cross (1 XMR vs seed's 1 XMR -> ratio 1) yields confidence(1,1,Z) ≈
  // 0.207 — the higher edge, so aId is the top non-seed node and survives
  // normalization with zapPostTrust > 0. cId's criss-cross (2 XMR vs seed's 1 XMR
  // -> ratio 0.5) yields confidence(0.5,1.5,Z) ≈ 0.036, a distinct lower value,
  // giving the normalization a non-zero spread.
  await seedCrissCross({ curatorId: aId, curatorAmount: AMOUNT_A, firstMinor: 0, recipientAccountId: recipient.id, base })
  await seedCrissCross({ curatorId: cId, curatorAmount: AMOUNT_C, firstMinor: 4, recipientAccountId: recipient.id, base })

  await trust({ models: prisma })
})

afterAll(async () => {
  await prisma.userSubTrust.deleteMany({ where: { subName: territoryName } })
  await prisma.observedTip.deleteMany({ where: { id: { in: created.tips } } })
  for (const id of created.items) {
    await prisma.itemUserAgg.deleteMany({ where: { itemId: id } })
    await prisma.item.deleteMany({ where: { id } })
  }
  await prisma.sub.deleteMany({ where: { name: { in: created.subs } } })
  await prisma.moneroAccount.deleteMany({ where: { id: { in: created.accounts } } })
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } })
  await prisma.$disconnect()
})

test('records seed trust for the territory (unconditional random-walk seed injection)', async () => {
  // The global seed (stasher) is injected into the graph unconditionally via
  // unnest(seeds), so it gets a UserSubTrust row from the random walk. Because the
  // graph is non-empty here (results.length > 0), the initialTrust fallback at
  // worker/trust.js:62-64 is NOT the source of this row — it comes from the walk.
  // (The territory founder owns the turf but does not tip in this fixture, so it
  // accrues no trust and is correctly absent — trust is earned by tipping.)
  const rows = await prisma.userSubTrust.findMany({ where: { subName: territoryName } })
  expect(rows.length).toBeGreaterThan(0)
  const userIds = rows.map(r => r.userId)
  expect(userIds).toContain(USER_ID.untraceable) // 616 — global seed, injected unconditionally
})

test('derives non-zero zapPostTrust for a confirmed-tip curator from the observation tables', async () => {
  // Before the rewire the graph read the dead PayIn table (no rows) → the curator
  // contributed no edges → no UserSubTrust row → zapPostTrust stayed 0. After the
  // rewire the CONFIRMED ObservedTip criss-cross is a real edge the seed follows, so
  // the curator accrues trust from the live observation tables.
  const row = await prisma.userSubTrust.findUnique({ where: { userId_subName: { userId: aId, subName: territoryName } } })
  expect(row).toBeTruthy()
  expect(row.zapPostTrust).toBeGreaterThan(0)
})

test('does not carry trust for a non-tipping author (sanity)', async () => {
  // authorId authored the posts but never tipped — no observation edge, no trust.
  const row = await prisma.userSubTrust.findUnique({ where: { userId_subName: { userId: authorId, subName: territoryName } } })
  expect(row).toBeNull()
})
