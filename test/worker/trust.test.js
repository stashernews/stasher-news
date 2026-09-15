/* eslint-env jest */

// Integration test for worker/trust.js — verifies the trust graph reads from the
// live P2P observation tables (ObservedTip / ObservedDownvote), NOT the dead
// PayIn/ItemPayIn tables. The nightly trust job (pgboss 'trust', 0 2 * * * UTC)
// consumes this graph to populate UserSubTrust per ACTIVE territory; Task 2 of the
// merged plan consumes UserSubTrust.zapPostTrust/etc. to weight live tips.
//
// A trust edge needs only a ONE-directional follow: sum() FILTER returns NULL
// over no matching rows, and the NULL aggregates used to zero every
// one-directional edge in trust_pairs (b_total - after -> NULL -> CASE ELSE 0).
// Since 2026-08-21 trust_pairs COALESCEs its aggregate terms, so a seed that
// only ever follows a curator still emits a confidence() edge — pinned by the
// one-directional fixture/test (oneWayTerritoryName). The criss-cross fixtures
// below additionally exercise the two-direction shape (both before and after
// non-NULL).
//
// Real DB integration mirroring test/worker/rewardsDistributor.test.js (live migrated
// database, FK-safe teardown). Run via the app container:
//   docker exec -u apprunner app npx jest test/worker/trust.test.js

import { PrismaClient } from '@prisma/client'
import { trust } from '@/worker/trust'
import { USER_ID } from '@/lib/constants'

const prisma = new PrismaClient()

// The global trust seed is the stasher user (USER_ID.stasher = 616). For GLOBAL
// trust (zapPostTrust) to reach a curator, the seed must itself tip — the random
// walk restarts at the seed each iteration, so only nodes the seed "follows" accrue
// trust. This is exactly what the brief's RED note describes: before the rewire the
// seeded user contributed no edges (the dead PayIn table had no rows), so the
// curator's zapPostTrust stayed 0.
const SEED_USER = USER_ID.stasher // 616

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
const seedTerritoryName = `trust-seed-turf-${process.pid}-${Date.now()}`
// Fresh turf pair used ONLY by multi-turf fixtures: cross-posted items live in
// BOTH, so membership matching must derive trust for aId in BOTH. Pre-fix,
// subNames[1] (first element, unordered array_agg) equals at most one of them,
// so at least one of the two assertions per test fails — the red state is
// deterministic regardless of array order.
const multiTurfA = `trust-multi-a-${process.pid}-${Date.now()}`
const multiTurfB = `trust-multi-b-${process.pid}-${Date.now()}`
// One-directional territory: the seed FOLLOWS two curators (tips after them on
// a single shared post each) and is never followed back — every (seed, curator)
// pair has NULL `after` and every (curator, seed) pair has NULL `before`.
// Pre-fix, the NULL aggregates zeroed ALL these edges and this territory could
// only ever store fallback seed rows.
const oneWayTerritoryName = `trust-oneway-${process.pid}-${Date.now()}`

let founderId
let authorId
let aId
let cId
let priorHeartbeat = null

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(rows[0].id)
  return rows[0].id
}

async function mkPost (subName = territoryName) {
  // Production items get their subNames array maintained by the item_subnames
  // trigger from ItemSub rows (api/payIn/types/itemCreate.js writes the subs
  // relation, never the column); the legacy scalar Item.subName is never
  // written by this fork. The fixture mirrors the production path — ItemSub
  // row in, trigger-maintained subNames array out.
  const item = await prisma.item.create({
    data: { userId: authorId, title: 'trust graph post', subs: { create: [{ subName }] }, status: 'ACTIVE' }
  })
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(item.id)}::ltree WHERE id = ${item.id}::int`
  created.items.push(item.id)
  return item.id
}

async function mkComment (rootId, subName = territoryName) {
  const item = await prisma.item.create({
    data: { userId: authorId, text: 'trust graph comment', parentId: rootId, rootId, subs: { create: [{ subName }] }, status: 'ACTIVE' }
  })
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(rootId) + '.' + item.id}::ltree WHERE id = ${item.id}::int`
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

// Comment-graph mirror of seedCrissCross: territory resolves via the ROOT
// item's subNames (membership: COALESCE(root.subNames, item.subNames) in the
// graph query), so comment tips must land on comments whose root post is in
// the territory.
async function seedCommentCrissCross ({ curatorId, curatorAmount, firstMinor, recipientAccountId, base }) {
  const root = await mkPost()
  const commentA = await mkComment(root)
  const commentB = await mkComment(root)
  await seedTip({ postId: commentA, tipperId: curatorId, piconeros: curatorAmount, confirmedAt: new Date(base + firstMinor * 60000), recipientAccountId })
  await seedTip({ postId: commentA, tipperId: SEED_USER, piconeros: AMOUNT_SEED, confirmedAt: new Date(base + (firstMinor + 1) * 60000), recipientAccountId })
  await seedTip({ postId: commentB, tipperId: SEED_USER, piconeros: AMOUNT_SEED, confirmedAt: new Date(base + (firstMinor + 2) * 60000), recipientAccountId })
  await seedTip({ postId: commentB, tipperId: curatorId, piconeros: curatorAmount, confirmedAt: new Date(base + (firstMinor + 3) * 60000), recipientAccountId })
}

// Multi-turf mirrors: same production path as mkPost/mkComment but the ItemSub
// create list has TWO entries, so the trigger-maintained subNames array holds
// both turfs — the cross-post shape whose trust attribution this suite guards.
async function mkMultiTurfPost () {
  const item = await prisma.item.create({
    data: { userId: authorId, title: 'multi turf post', subs: { create: [{ subName: multiTurfA }, { subName: multiTurfB }] }, status: 'ACTIVE' }
  })
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(item.id)}::ltree WHERE id = ${item.id}::int`
  created.items.push(item.id)
  return item.id
}

async function mkMultiTurfComment (rootId) {
  const item = await prisma.item.create({
    data: { userId: authorId, text: 'multi turf comment', parentId: rootId, rootId, subs: { create: [{ subName: multiTurfA }, { subName: multiTurfB }] }, status: 'ACTIVE' }
  })
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(rootId) + '.' + item.id}::ltree WHERE id = ${item.id}::int`
  created.items.push(item.id)
  return item.id
}

// Multi-turf criss-cross: posts AND a comment thread whose items all live in
// BOTH multiTurfA and multiTurfB, tipped criss-cross by the curator and the
// global seed. Mirrors seedCrissCross/seedCommentCrissCross shapes.
async function seedMultiTurfCrissCross ({ curatorId, curatorAmount, firstMinor, recipientAccountId, base }) {
  const postA = await mkMultiTurfPost()
  const postB = await mkMultiTurfPost()
  await seedTip({ postId: postA, tipperId: curatorId, piconeros: curatorAmount, confirmedAt: new Date(base + firstMinor * 60000), recipientAccountId })
  await seedTip({ postId: postA, tipperId: SEED_USER, piconeros: AMOUNT_SEED, confirmedAt: new Date(base + (firstMinor + 1) * 60000), recipientAccountId })
  await seedTip({ postId: postB, tipperId: SEED_USER, piconeros: AMOUNT_SEED, confirmedAt: new Date(base + (firstMinor + 2) * 60000), recipientAccountId })
  await seedTip({ postId: postB, tipperId: curatorId, piconeros: curatorAmount, confirmedAt: new Date(base + (firstMinor + 3) * 60000), recipientAccountId })

  const root = await mkMultiTurfPost()
  const commentA = await mkMultiTurfComment(root)
  const commentB = await mkMultiTurfComment(root)
  await seedTip({ postId: commentA, tipperId: curatorId, piconeros: curatorAmount, confirmedAt: new Date(base + (firstMinor + 4) * 60000), recipientAccountId })
  await seedTip({ postId: commentA, tipperId: SEED_USER, piconeros: AMOUNT_SEED, confirmedAt: new Date(base + (firstMinor + 5) * 60000), recipientAccountId })
  await seedTip({ postId: commentB, tipperId: SEED_USER, piconeros: AMOUNT_SEED, confirmedAt: new Date(base + (firstMinor + 6) * 60000), recipientAccountId })
  await seedTip({ postId: commentB, tipperId: curatorId, piconeros: curatorAmount, confirmedAt: new Date(base + (firstMinor + 7) * 60000), recipientAccountId })
}

// One-directional follow: on a single shared post the curator tips first and
// the seed tips after — the seed "follows" the curator, never the reverse.
// For the (seed, curator) pair: before = min-ratio > 0, after = NULL,
// disagree = 0, b_total = 1 → post-fix edge = confidence(before, 1).
// aId: confidence(1, 1, Z) ≈ 0.207. cId: confidence(0.5, 1, Z) ≈ 0.055 —
// distinct values, so the walk's normalization spreads them (founder stays
// the zero/min node) and BOTH curators normalize to zapPostTrust > 0.
async function seedOneWayFollow ({ curatorId, curatorAmount, firstMinor, recipientAccountId, base }) {
  const post = await mkPost(oneWayTerritoryName)
  await seedTip({ postId: post, tipperId: curatorId, piconeros: curatorAmount, confirmedAt: new Date(base + firstMinor * 60000), recipientAccountId })
  await seedTip({ postId: post, tipperId: SEED_USER, piconeros: AMOUNT_SEED, confirmedAt: new Date(base + (firstMinor + 1) * 60000), recipientAccountId })
}

beforeAll(async () => {
  // Snapshot the heartbeat so teardown can restore it. healthProbe owns the
  // row's other fields (it upserts id=1 every 60s on dev) — we only touch
  // trustCompletedAt and must never delete the row.
  const heartbeatBefore = await prisma.healthSnapshot.findUnique({ where: { id: 1 }, select: { trustCompletedAt: true } })
  priorHeartbeat = heartbeatBefore?.trustCompletedAt ?? null

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

  // Seed-user-owned territory: GLOBAL_SEEDS is a single user (616), so a
  // zero-activity territory owned by that user yields 1-node graphs — the
  // mathjs squeeze crash path (Bug 2).
  await prisma.sub.create({
    data: {
      name: seedTerritoryName,
      userId: SEED_USER,
      rankingType: 'WOT',
      billingType: 'ONCE',
      billingCost: 1_000_000_000,
      status: 'ACTIVE',
      billingStatus: 'PAID'
    }
  })
  created.subs.push(seedTerritoryName)

  // Multi-turf pair for membership-matching fixtures (owner irrelevant to the
  // global-walk assertions; founderId mirrors territoryName).
  for (const name of [multiTurfA, multiTurfB]) {
    await prisma.sub.create({
      data: {
        name,
        userId: founderId,
        rankingType: 'WOT',
        billingType: 'ONCE',
        billingCost: 1_000_000_000,
        status: 'ACTIVE',
        billingStatus: 'PAID'
      }
    })
    created.subs.push(name)
  }

  // One-directional territory for the NULL-aggregate guard (owner founderId
  // mirrors territoryName; see oneWayTerritoryName above).
  await prisma.sub.create({
    data: {
      name: oneWayTerritoryName,
      userId: founderId,
      rankingType: 'WOT',
      billingType: 'ONCE',
      billingCost: 1_000_000_000,
      status: 'ACTIVE',
      billingStatus: 'PAID'
    }
  })
  created.subs.push(oneWayTerritoryName)

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
  await seedCommentCrissCross({ curatorId: aId, curatorAmount: AMOUNT_A, firstMinor: 8, recipientAccountId: recipient.id, base })
  await seedCommentCrissCross({ curatorId: cId, curatorAmount: AMOUNT_C, firstMinor: 12, recipientAccountId: recipient.id, base })

  // TWO curators with DIFFERENT amounts — required: with a single curator the
  // multi-turf graphs would have exactly one non-seed non-zero node, std=0,
  // and trustGivenGraph's normalization zeroes it (the reason territoryName's
  // fixture seeds both AMOUNT_A and AMOUNT_C). Mirroring both curators gives
  // each multi-turf graph the same non-zero-spread shape as territoryName's.
  await seedMultiTurfCrissCross({ curatorId: aId, curatorAmount: AMOUNT_A, firstMinor: 16, recipientAccountId: recipient.id, base })
  await seedMultiTurfCrissCross({ curatorId: cId, curatorAmount: AMOUNT_C, firstMinor: 24, recipientAccountId: recipient.id, base })

  // One-directional follows: seed tips AFTER each curator on one post, never
  // before — the NULL-after shape that pre-fix zeroed every edge.
  await seedOneWayFollow({ curatorId: aId, curatorAmount: AMOUNT_A, firstMinor: 32, recipientAccountId: recipient.id, base })
  await seedOneWayFollow({ curatorId: cId, curatorAmount: AMOUNT_C, firstMinor: 36, recipientAccountId: recipient.id, base })

  await trust({ models: prisma })
})

afterAll(async () => {
  await prisma.userSubTrust.deleteMany({ where: { subName: territoryName } })
  await prisma.observedTip.deleteMany({ where: { id: { in: created.tips } } })
  for (const id of created.items) {
    await prisma.itemUserAgg.deleteMany({ where: { itemId: id } })
    await prisma.item.deleteMany({ where: { id } })
  }
  await prisma.userSubTrust.deleteMany({ where: { subName: seedTerritoryName } })
  await prisma.userSubTrust.deleteMany({ where: { subName: { in: [multiTurfA, multiTurfB] } } })
  await prisma.userSubTrust.deleteMany({ where: { subName: oneWayTerritoryName } })
  await prisma.sub.deleteMany({ where: { name: { in: created.subs } } })
  await prisma.moneroAccount.deleteMany({ where: { id: { in: created.accounts } } })
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } })
  // Restore the pre-suite heartbeat (leave-no-trace; the row itself belongs
  // to healthProbe). Killed-run caveat: an interrupted run can leave a fresh
  // test heartbeat behind, masking staleness on dev until the next real
  // nightly walk overwrites it — same residue class as fixture residue.
  await prisma.healthSnapshot.updateMany({ where: { id: 1 }, data: { trustCompletedAt: priorHeartbeat } })
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
  expect(userIds).toContain(USER_ID.stasher) // 616 — global seed, injected unconditionally
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

test('stores fallback trust rows for a seed-owned zero-activity territory (1x1 squeeze guard)', async () => {
  // GLOBAL_SEEDS is a single user (616). A territory owned by that user with no
  // qualifying tips yields 1-node graphs; pre-fix math.squeeze collapsed the
  // 1x1 result to a bare number and sqapply crashed (vec.size is not a
  // function), so the per-territory catch skipped even the initialTrust
  // fallback and NO UserSubTrust rows were stored for the territory.
  const rows = await prisma.userSubTrust.findMany({ where: { subName: seedTerritoryName } })
  expect(rows.length).toBeGreaterThan(0)
  expect(rows.map(r => r.userId)).toContain(SEED_USER)
})

test('derives non-zero zapCommentTrust for a confirmed-tip comment curator', async () => {
  // Comments resolve territory via the ROOT item's subNames array — the scalar
  // Item.subName is never written by this fork, so the pre-fix comment graph
  // matched zero items and zapCommentTrust could only come from the seed-only
  // fallback (which stores no curator rows).
  const row = await prisma.userSubTrust.findUnique({ where: { userId_subName: { userId: aId, subName: territoryName } } })
  expect(row).toBeTruthy()
  expect(row.zapCommentTrust).toBeGreaterThan(0)
})

test('does not carry trust for a non-tipping author (sanity)', async () => {
  // authorId authored the posts but never tipped — no observation edge, no trust.
  const row = await prisma.userSubTrust.findUnique({ where: { userId_subName: { userId: authorId, subName: territoryName } } })
  expect(row).toBeNull()
})

test('derives non-zero zapPostTrust in EVERY turf a cross-posted post belongs to', async () => {
  // Pre-fix, the graph matched COALESCE(subNames[1], 'meta') = subName — first
  // element of an unordered array_agg — so the multi-turf criss-cross tips
  // reached at most ONE of the two turfs and the other had no aId edge.
  // Post-fix (subNames @> ARRAY[subName]) both turfs' post graphs contain the
  // seed->aId edge, so aId accrues zapPostTrust in both. Asserting on BOTH
  // makes the pre-fix failure deterministic regardless of array order.
  const rowA = await prisma.userSubTrust.findUnique({ where: { userId_subName: { userId: aId, subName: multiTurfA } } })
  const rowB = await prisma.userSubTrust.findUnique({ where: { userId_subName: { userId: aId, subName: multiTurfB } } })
  expect(rowA).toBeTruthy()
  expect(rowA.zapPostTrust).toBeGreaterThan(0)
  expect(rowB).toBeTruthy()
  expect(rowB.zapPostTrust).toBeGreaterThan(0)
})

test('derives non-zero zapCommentTrust in EVERY turf the comment thread belongs to', async () => {
  // Comment territory resolves via the ROOT item's subNames — same membership
  // requirement as posts. The multi-turf root lives in both turfs, so tipped
  // comments on it must count toward zapCommentTrust in both.
  const rowA = await prisma.userSubTrust.findUnique({ where: { userId_subName: { userId: aId, subName: multiTurfA } } })
  const rowB = await prisma.userSubTrust.findUnique({ where: { userId_subName: { userId: aId, subName: multiTurfB } } })
  expect(rowA).toBeTruthy()
  expect(rowA.zapCommentTrust).toBeGreaterThan(0)
  expect(rowB).toBeTruthy()
  expect(rowB.zapCommentTrust).toBeGreaterThan(0)
})

test('derives non-zero zapPostTrust from a ONE-DIRECTIONAL seed follow (NULL aggregate guard)', async () => {
  // sum() FILTER over no matching rows returns NULL, not 0. Pre-fix, the
  // (seed, curator) pair's NULL `after` made `b_total - after` NULL, the CASE
  // in trust_pairs fell to ELSE 0, and EVERY one-directional edge was zero —
  // the walk left all non-seed nodes at 0 and only fallback seed rows were
  // stored (the live "std 0 ... adding seeds" signature). Post-fix (COALESCE
  // in trust_pairs), the seed's follow counts as successes: aId's 1-XMR
  // follow is confidence(1,1,Z) ≈ 0.207 and cId's 2-XMR follow is
  // confidence(0.5,1,Z) ≈ 0.055 — distinct values so normalization keeps
  // both > 0 (the non-tipping founder stays the zero/min node).
  const rowA = await prisma.userSubTrust.findUnique({ where: { userId_subName: { userId: aId, subName: oneWayTerritoryName } } })
  const rowC = await prisma.userSubTrust.findUnique({ where: { userId_subName: { userId: cId, subName: oneWayTerritoryName } } })
  expect(rowA).toBeTruthy()
  expect(rowA.zapPostTrust).toBeGreaterThan(0)
  expect(rowC).toBeTruthy()
  expect(rowC.zapPostTrust).toBeGreaterThan(0)
})

test('a fully-successful walk writes the trust heartbeat (HealthSnapshot.trustCompletedAt)', async () => {
  const row = await prisma.healthSnapshot.findUnique({ where: { id: 1 }, select: { trustCompletedAt: true } })
  expect(row).not.toBeNull()
  expect(row.trustCompletedAt).toBeInstanceOf(Date)
  // written by THIS run (beforeAll's trust() call), not a stale value
  expect(row.trustCompletedAt.getTime()).toBeGreaterThan(Date.now() - 10 * 60 * 1000)
})
