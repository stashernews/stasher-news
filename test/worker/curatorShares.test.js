/* eslint-env jest */

// Integration test for computeCuratorShares (Phase 4 Task 7 / spec §5).
//
// computeCuratorShares ports SN's worker/earn.js reward-share CTE to StasherNews:
// it reads confirmed ObservedTip rows (P2P Monero tips) instead of legacy PayIn
// ZAPs, ranks the tipped items by weightedVotes-weightedDownVotes, and apportions
// a weekly rewards pool (piconeros) to the curators (tippers) of top content.
// Sub-minPayout shares are excluded and roll over (not redistributed); topN caps
// the number of recipients.
//
// The SQL needs real Item/User/ObservedTip rows, so this is a real-DB integration
// test mirroring test/worker/confirmFinalizer.test.js (live migrated database,
// per-test seeding, FK-safe teardown).
//
// Run via the app container:
//   docker exec -u apprunner app npx jest test/worker/curatorShares.test.js

import { PrismaClient } from '@prisma/client'
import { computeCuratorShares } from '@/worker/curatorShares'

const prisma = new PrismaClient()

const ADDR = '7' + '4'.repeat(94) // 95-char Monero address placeholder

// Tracks every row created across tests so afterAll can tear them down in
// FK-safe order: ObservedTip -> Item -> MoneroAccount -> users.
const created = { users: [], items: [], accounts: [], tips: [] }

// The shared seed: 3 ranked root posts + 4 tippers (3 heavy, 1 dust). The dust
// tipper (D) tips just above the ZAP_THRESHOLD on the lowest-ranked post, so its
// computed share falls below minPayout and rolls over.
let seed
const POOL = 10_000_000_000n // 1e10 piconeros (~0.00001 XMR-scale test pool)
let periodStart, periodEnd

beforeAll(async () => {
  // A wide window around "now" so freshly seeded rows fall inside it.
  periodStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  periodEnd = new Date(Date.now() + 24 * 60 * 60 * 1000)
  seed = await seedScenario(periodStart)
})

afterAll(async () => {
  await prisma.observedTip.deleteMany({ where: { id: { in: created.tips } } })
  for (const id of created.items) {
    await prisma.itemUserAgg.deleteMany({ where: { itemId: id } })
    await prisma.item.deleteMany({ where: { id } })
  }
  for (const id of created.accounts) await prisma.moneroAccount.deleteMany({ where: { id } })
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } })
  await prisma.$disconnect()
})

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  const id = rows[0].id
  created.users.push(id)
  return id
}

// Root post with an explicit weightedVotes (and zero weightedDownVotes) so it
// ranks without simulating the full trust/vote pipeline. path is the item's own
// id as a single ltree label (SN convention).
async function createRootPost (userId, title, weightedVotes) {
  const rows = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", title, "weightedVotes")
    VALUES (${userId}::int, ${title}, ${weightedVotes}::float)
    RETURNING id::int AS id`
  const id = rows[0].id
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(id)}::ltree WHERE id = ${id}::int`
  created.items.push(id)
  return id
}

// A minimal MoneroAccount to satisfy ObservedTip.recipientAccountId (FK RESTRICT).
let accountSeq = 0
async function seedAccount () {
  accountSeq += 1
  const account = await prisma.moneroAccount.create({
    data: {
      ownerUserId: null,
      address: ADDR + String(accountSeq), // unique per ([address, network])
      label: 'test',
      network: 'STAGENET',
      status: 'ACTIVE'
    }
  })
  created.accounts.push(account.id)
  return account
}

let tipSeq = 0
async function seedTip ({ postId, tipperId, piconeros, confirmedAt, recipientAccountId }) {
  tipSeq += 1
  const tip = await prisma.observedTip.create({
    data: {
      txHash: 'cs' + String(tipSeq),
      postId,
      tipperId,
      recipientAccountId,
      recipientMajor: 0,
      recipientMinor: 0,
      paymentId: 'cstest' + String(tipSeq).padStart(8, '0') + '00000000',
      piconeros,
      height: 2000,
      confirmations: 10,
      state: 'CONFIRMED',
      proofType: 'INDEXED',
      confirmedAt
    }
  })
  created.tips.push(tip.id)
  return tip
}

async function seedScenario (period) {
  const account = await seedAccount()

  // 3 ranked root posts (weightedVotes > 0, no downvotes).
  const [u1, u2, u3] = await Promise.all([
    createUser(), createUser(), createUser()
  ])
  const item1 = await createRootPost(u1, 'top post', 100) // rank 1
  const item2 = await createRootPost(u2, 'mid post', 50) // rank 2
  const item3 = await createRootPost(u3, 'low post', 10) // rank 3

  // Tippers (curators). confirmedAt ordering controls the early_multiplier
  // (earlier tipper on an item wins). All tips CONFIRMED inside the period.
  const tA = await createUser()
  const tB = await createUser()
  const tC = await createUser()
  const tD = await createUser() // dust tipper -> sub-minPayout share

  const min = 60 * 1000
  await seedTip({ postId: item1, tipperId: tA, piconeros: 5_000_000_000_000n, confirmedAt: new Date(Date.now() + 1 * min), recipientAccountId: account.id })
  await seedTip({ postId: item1, tipperId: tB, piconeros: 3_000_000_000_000n, confirmedAt: new Date(Date.now() + 2 * min), recipientAccountId: account.id })
  await seedTip({ postId: item2, tipperId: tB, piconeros: 2_000_000_000_000n, confirmedAt: new Date(Date.now() + 1 * min), recipientAccountId: account.id })
  await seedTip({ postId: item2, tipperId: tC, piconeros: 1_000_000_000_000n, confirmedAt: new Date(Date.now() + 2 * min), recipientAccountId: account.id })
  // dust: just above ZAP_THRESHOLD_PICONEROS (1e8), on the lowest-ranked post.
  await seedTip({ postId: item3, tipperId: tD, piconeros: 100_000_001n, confirmedAt: new Date(Date.now() + 1 * min), recipientAccountId: account.id })

  return { account, tippers: { tA, tB, tC, tD }, items: { item1, item2, item3 } }
}

test('computeCuratorShares returns shares that exactly reconcile to the pool', async () => {
  const { shares, distributedPiconeros, rolledOverPiconeros } = await computeCuratorShares(
    periodStart, periodEnd, POOL, { minPayout: 1_000_000_000n, topN: 100 }, prisma)

  expect(BigInt(distributedPiconeros) + BigInt(rolledOverPiconeros)).toBe(POOL)
  expect(BigInt(distributedPiconeros)).toBeLessThanOrEqual(POOL)
  expect(BigInt(rolledOverPiconeros)).toBeGreaterThanOrEqual(0n)
  expect(shares.length).toBeGreaterThan(0)
})

test('every returned share meets minPayout', async () => {
  const minPayout = 1_000_000_000n
  const { shares } = await computeCuratorShares(
    periodStart, periodEnd, POOL, { minPayout, topN: 100 }, prisma)

  for (const s of shares) {
    expect(BigInt(s.sharePiconeros)).toBeGreaterThanOrEqual(minPayout)
  }
})

test('a dust curator whose share is below minPayout is excluded (rolls over)', async () => {
  const { shares } = await computeCuratorShares(
    periodStart, periodEnd, POOL, { minPayout: 1_000_000_000n, topN: 100 }, prisma)

  const curatorIds = shares.map(s => Number(s.curatorId))
  // heavy tippers are included ...
  expect(curatorIds).toContain(seed.tippers.tA)
  expect(curatorIds).toContain(seed.tippers.tB)
  expect(curatorIds).toContain(seed.tippers.tC)
  // ... the dust tipper is excluded (its share rolled over, not redistributed).
  expect(curatorIds).not.toContain(seed.tippers.tD)
})

test('minPayout above every share excludes all recipients (full rollover)', async () => {
  const { shares, distributedPiconeros, rolledOverPiconeros } = await computeCuratorShares(
    periodStart, periodEnd, POOL, { minPayout: POOL + 1n, topN: 100 }, prisma)

  expect(shares).toEqual([])
  expect(BigInt(distributedPiconeros)).toBe(0n)
  expect(BigInt(rolledOverPiconeros)).toBe(POOL)
})

test('minPayout of zero includes every qualifying curator', async () => {
  const { shares, distributedPiconeros } = await computeCuratorShares(
    periodStart, periodEnd, POOL, { minPayout: 0n, topN: 100 }, prisma)

  const curatorIds = shares.map(s => Number(s.curatorId))
  expect(curatorIds).toContain(seed.tippers.tD)
  expect(BigInt(distributedPiconeros)).toBeLessThanOrEqual(POOL)
})

test('topN caps the number of recipients', async () => {
  // There are 4 qualifying curators; cap to 2 -> exactly 2 shares, the two
  // highest-proportion ones (tB, then tA).
  const { shares } = await computeCuratorShares(
    periodStart, periodEnd, POOL, { minPayout: 0n, topN: 2 }, prisma)

  expect(shares.length).toBe(2)
  const curatorIds = shares.map(s => Number(s.curatorId)).sort()
  expect(curatorIds).toEqual([seed.tippers.tA, seed.tippers.tB].sort())
})

test('same inputs yield identical shares (determinism)', async () => {
  const a = await computeCuratorShares(periodStart, periodEnd, POOL, { minPayout: 1_000_000_000n, topN: 100 }, prisma)
  const b = await computeCuratorShares(periodStart, periodEnd, POOL, { minPayout: 1_000_000_000n, topN: 100 }, prisma)
  // BigInt-safe serialization (JSON.stringify can't handle BigInt natively).
  const replacer = (_, v) => (typeof v === 'bigint' ? String(v) : v)
  expect(JSON.stringify(a, replacer)).toEqual(JSON.stringify(b, replacer))
})

test('an empty period yields no shares and a full rollover', async () => {
  // A window far in the future that contains none of the seeded tips/items.
  const futureStart = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
  const futureEnd = new Date(Date.now() + 366 * 24 * 60 * 60 * 1000)
  const { shares, distributedPiconeros, rolledOverPiconeros } = await computeCuratorShares(
    futureStart, futureEnd, POOL, { minPayout: 0n, topN: 100 }, prisma)

  expect(shares).toEqual([])
  expect(BigInt(distributedPiconeros)).toBe(0n)
  expect(BigInt(rolledOverPiconeros)).toBe(POOL)
})

test('anonymous tips (null tipperId) never create curator shares', async () => {
  // Anonymous tippers (logged-out initiateTip) must not earn curator rewards:
  // their payouts would be unpayable (no registered receiving account). The
  // shares + proportions must be bit-for-bit identical with and without a large
  // anonymous tip on the top-ranked post.
  const params = { minPayout: 0n, topN: 100 }
  const before = await computeCuratorShares(periodStart, periodEnd, POOL, params, prisma)

  await seedTip({
    postId: seed.items.item1,
    tipperId: null,
    piconeros: 50_000_000_000_000n,
    confirmedAt: new Date(),
    recipientAccountId: seed.account.id
  })

  const after = await computeCuratorShares(periodStart, periodEnd, POOL, params, prisma)
  expect(after.shares.map(s => Number(s.curatorId)).sort()).toEqual(before.shares.map(s => Number(s.curatorId)).sort())
  expect(after.shares.map(s => Number(s.sharePiconeros)).sort()).toEqual(before.shares.map(s => Number(s.sharePiconeros)).sort())
})

test('each share carries per-type earns that sum exactly to the share', async () => {
  const { shares } = await computeCuratorShares(
    periodStart, periodEnd, POOL, { minPayout: 1_000_000_000n, topN: 100 }, prisma)

  expect(shares.length).toBeGreaterThan(0)
  for (const s of shares) {
    expect(s.earns.length).toBeGreaterThan(0)
    for (const e of s.earns) {
      expect(['TIP_POST', 'TIP_COMMENT']).toContain(e.type)
      expect(e.rank).toBeGreaterThan(0)
    }
    const earnedSum = s.earns.reduce((acc, e) => acc + BigInt(e.piconeros), 0n)
    expect(earnedSum).toBe(BigInt(s.sharePiconeros))
  }
})

// HANDICAP_IDS restore (A-09 Task 1): staff users 616/4502 get a 0.5x curator
// proportion. Two identical posts with identical tips; the handicapped one's
// curator share must be exactly half the other's. User 616 is the real seed
// account `untraceable` in the dev DB, so the insert tracks it for teardown
// only if it truly creates the row — the pre-existing user is never deleted.
const HANDICAP_USER_ID = 616

test('staff curators (HANDICAP_IDS) get a 0.5x curator proportion', async () => {
  const inserted = await prisma.$queryRaw`
    INSERT INTO users (id) VALUES (${HANDICAP_USER_ID}) ON CONFLICT DO NOTHING RETURNING id::int AS id`
  if (inserted.length > 0) {
    // fresh insert (temporary fixture) — tracked so afterAll removes it
    created.users.push(HANDICAP_USER_ID)
  }

  const normalUser = await createUser()
  const recipientAccount = await seedAccount()
  const normalPost = await createRootPost(normalUser, 'normal handicap control post', 10)
  const staffPost = await createRootPost(HANDICAP_USER_ID, 'staff handicapped post', 10)
  const confirmedAt = new Date(Date.now() + 60 * 1000) // inside the shared period window
  await seedTip({ postId: normalPost, tipperId: normalUser, piconeros: 1_000_000_000n, confirmedAt, recipientAccountId: recipientAccount.id })
  await seedTip({ postId: staffPost, tipperId: HANDICAP_USER_ID, piconeros: 1_000_000_000n, confirmedAt, recipientAccountId: recipientAccount.id })

  const { shares } = await computeCuratorShares(
    periodStart, periodEnd, 10_000_000_000_000n, {}, prisma)

  const normalShare = shares.find(s => s.curatorId === normalUser)
  const staffShare = shares.find(s => s.curatorId === HANDICAP_USER_ID)
  expect(staffShare).toBeDefined()
  expect(normalShare).toBeDefined()
  // Both curators tipped identical amounts on identical posts; the staff
  // handicap halves the proportion, so the staff share is exactly half.
  expect(staffShare.sharePiconeros).toBe(normalShare.sharePiconeros / 2n)
})
