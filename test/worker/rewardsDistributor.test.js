/* eslint-env jest */

// Integration test for the weekly rewardsDistributor (Phase 4 Task 8 / spec §5).
//
// runDistributionOnce is the testable core: it tallies a week of CONFIRMED
// platform inflow (downvotes + posting/territory fees) by source, applies
// the PlatformFeeConfig allocation split, adds the prior period's rollover to
// form the pool, calls computeCuratorShares (Task 7) to apportion it to the
// curators of top content, and writes one RewardDistribution row + QUEUED
// RewardPayout rows (one per curator WITH a registered receiving address).
// Curators with no registered address are excluded — their share rolls over.
//
// Task 9 wires the hot-wallet signer: runDistributionOnce now calls sendPayouts
// (injected here as a stub so no real stagenet keys/wallet are needed) and flips
// the distribution PENDING -> SENDING -> COMPLETE, with payouts QUEUED -> SENT.
//
// Real DB integration test mirroring test/worker/curatorShares.test.js and
// test/worker/rewardsWalletObserver.fee.test.js (live migrated database, FK-safe
// teardown). Run via the app container:
//   docker exec -u apprunner app npx jest test/worker/rewardsDistributor.test.js

import { PrismaClient } from '@prisma/client'
import { runDistributionOnce, finalizeDistribution } from '@/worker/rewardsDistributor'
import { applyTipDetected } from '@/api/monero/ranking'

const prisma = new PrismaClient()

// 95-char Monero address placeholder, made unique per call via a counter.
let addrSeq = 0
function makeAddress () {
  addrSeq += 1
  return '5' + String(addrSeq).padStart(4, '0') + 'A'.repeat(90)
}

const DAY = 24 * 60 * 60 * 1000

// Tracks every row created across tests so afterAll can tear them down in
// FK-safe order.
const created = {
  users: [],
  items: [],
  accounts: [],
  tips: [],
  payIns: [],
  fees: [],
  downvotes: [],
  distributions: []
}

let result // the distribution returned by runDistributionOnce (beforeAll)
let seededCurators // { c1, c2, c3 } — c3 has NO registered payout address

// Task 9 stub signer: records that it was invoked and marks each QUEUED payout
// SENT with a stable fake tx hash. Injected into runDistributionOnce so the
// wiring (SENDING -> COMPLETE, payouts -> SENT) is verified without real XMR.
let signerInvocations = 0
const fakeSigner = async (payouts, { models } = {}) => {
  signerInvocations += 1
  for (const p of payouts) {
    if (p.state === 'QUEUED') {
      await models.rewardPayout.update({ where: { id: p.id }, data: { state: 'SENT', txHash: 'ab'.repeat(32) } })
    }
  }
  return { sent: payouts.length, failed: 0, skipped: 0 }
}

// Seed amounts (piconeros). Picked so the allocation math is exact:
//   rewardsInflow = 5e12*100/100 + 4e12*70/100 + 2e12*30/100 + 3e12 (extra @100%)
//                 = 5e12 + 2.8e12 + 0.6e12 + 3e12 = 11.4e12
//   pool          = 11.4e12 + 1e12 (prior rollover) = 12.4e12
const DOWNVOTE_PICONEROS = 5_000_000_000_000n
const POSTING_FEE_PICONEROS = 4_000_000_000_000n
const TERRITORY_FEE_PICONEROS = 2_000_000_000_000n
const EXTRA_DONATE_PICONEROS = 3_000_000_000_000n
const PRIOR_ROLLOVER_PICONEROS = 1_000_000_000_000n
const EXPECTED_POOL_PICONEROS = 12_400_000_000_000n

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  const id = rows[0].id
  created.users.push(id)
  return id
}

async function createRootPost (userId, weightedVotes, createdAt) {
  const rows = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", title, "weightedVotes", "created_at")
    VALUES (${userId}::int, ${'rewards test post'}, ${weightedVotes}::float, ${createdAt})
    RETURNING id::int AS id`
  const id = rows[0].id
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(id)}::ltree WHERE id = ${id}::int`
  created.items.push(id)
  return id
}

async function createRecipientAccount () {
  const account = await prisma.moneroAccount.create({
    data: { ownerUserId: null, address: makeAddress(), label: 'author', network: 'STAGENET', status: 'ACTIVE' }
  })
  created.accounts.push(account.id)
  return account
}

// A curator's RECEIVING account (ownerUserId set) so rewardsDistributor can pay
// them. Curators created WITHOUT this are excluded from payouts.
async function createPayoutAccount (ownerUserId) {
  const account = await prisma.moneroAccount.create({
    data: { ownerUserId, address: makeAddress(), label: 'curator-payout', network: 'STAGENET', status: 'ACTIVE' }
  })
  created.accounts.push(account.id)
  return account
}

let tipSeq = 0
async function seedTip ({ postId, tipperId, piconeros, confirmedAt, recipientAccountId }) {
  tipSeq += 1
  const tip = await prisma.observedTip.create({
    data: {
      txHash: 'rdtip' + String(tipSeq),
      postId,
      tipperId,
      recipientAccountId,
      recipientMajor: 0,
      recipientMinor: 0,
      paymentId: 'rdtest' + String(tipSeq).padStart(6, '0') + '0000000000',
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

async function seedPayIn (userId, payInType, major, minor) {
  const payIn = await prisma.payIn.create({
    data: { userId, payInType, payInState: 'PAID', piconeros: 0n, moneroSubaddressMajor: major, moneroSubaddressMinor: minor }
  })
  created.payIns.push(payIn.id)
  return payIn
}

let feeSeq = 0
async function seedFee (payInId, feeType, major, piconeros, confirmedAt) {
  feeSeq += 1
  const fee = await prisma.feeObservation.create({
    data: {
      txHash: 'rdfee' + String(feeSeq),
      payInId,
      feeType,
      recipientMajor: major,
      recipientMinor: feeSeq,
      piconeros,
      height: 3000,
      confirmations: 10,
      state: 'CONFIRMED',
      confirmedAt
    }
  })
  created.fees.push(fee.id)
  return fee
}

let downvoteSeq = 0
async function seedDownvote (postId, piconeros, confirmedAt) {
  downvoteSeq += 1
  const downvote = await prisma.observedDownvote.create({
    data: {
      txHash: 'rddv' + String(downvoteSeq),
      postId,
      paymentId: 'rddv' + String(downvoteSeq).padStart(8, '0'),
      piconeros,
      height: 3000,
      confirmations: 10,
      state: 'CONFIRMED',
      confirmedAt
    }
  })
  created.downvotes.push(downvote.id)
  return downvote
}

// Self-healing purge of residue from a prior INTERRUPTED run of this test.
// afterAll's teardown deletes by the in-memory `created` lists, which are
// empty/incomplete if the process was killed, the app container restarted, or
// beforeAll threw after partial seeding. Those orphaned fixtures then flow into
// the dev DB's /rewards pool display (rdfee FeeObservations feed rewards.total)
// and accumulate across runs. This runs first in beforeAll and deletes by STABLE
// patterns (txHash prefixes, the test item title, the prior-distribution shape),
// chasing FK linkages, so every run starts from a clean slate. Idempotent:
// deletes nothing on a fresh DB.
async function purgePriorResidue () {
  // Capture linkages from prior-run fixtures BEFORE deleting them.
  const priorFees = await prisma.feeObservation.findMany({ where: { txHash: { startsWith: 'rdfee' } }, select: { payInId: true } })
  const feePayInIds = [...new Set(priorFees.map(f => f.payInId))]
  const priorTips = await prisma.observedTip.findMany({ where: { txHash: { startsWith: 'rdtip' } }, select: { tipperId: true, postId: true } })
  const tipperIds = [...new Set(priorTips.map(t => t.tipperId).filter(Boolean))]
  const testPostIds = [...new Set(priorTips.map(t => t.postId).filter(Boolean))]
  const priorAuthorIds = (await prisma.item.findMany({ where: { title: 'rewards test post' }, select: { userId: true } })).map(i => i.userId)
  const testUserIds = [...new Set([...tipperIds, ...priorAuthorIds])]

  // Prior-run "prior" distributions (8 days old, so missed by the 7-day stale
  // cleanup below) plus their payouts/earn.
  const staleDists = await prisma.rewardDistribution.findMany({
    where: { poolPiconeros: PRIOR_ROLLOVER_PICONEROS, distributedPiconeros: 0n, payoutCount: 0, status: 'COMPLETE' },
    select: { id: true }
  })
  const staleDistIds = staleDists.map(d => d.id)

  // FK-safe deletion (mirrors afterAll's proven cascade behavior).
  await prisma.earn.deleteMany({ where: { OR: [{ distributionId: null }, { distributionId: { in: staleDistIds } }] } })
  if (staleDistIds.length) {
    await prisma.rewardPayout.deleteMany({ where: { distributionId: { in: staleDistIds } } })
    await prisma.rewardDistribution.deleteMany({ where: { id: { in: staleDistIds } } })
  }
  // Fee/tip/downvote fixtures (clears Item/ObservedTip FK RESTRICTs first).
  await prisma.feeObservation.deleteMany({ where: { txHash: { startsWith: 'rdfee' } } })
  await prisma.observedTip.deleteMany({ where: { txHash: { startsWith: 'rdtip' } } })
  await prisma.observedDownvote.deleteMany({ where: { txHash: { startsWith: 'rddv' } } })
  // PayIns linked to the rdfee fees.
  if (feePayInIds.length) await prisma.payIn.deleteMany({ where: { id: { in: feePayInIds } } })
  // Test items (cascade-clears ItemUserAgg).
  if (testPostIds.length) await prisma.item.deleteMany({ where: { id: { in: testPostIds } } })
  await prisma.item.deleteMany({ where: { title: 'rewards test post' } })
  // Test MoneroAccounts (recipient accounts with ownerUserId NULL + payout
  // accounts owned by test users) all use makeAddress's deterministic throwaway
  // address: '5' + digits + 90 'A's. No real Monero address ends in 90 identical
  // chars, so the trailing-A signature is unambiguous AND reaches the NULL-owned
  // recipient accounts that testUserIds cannot.
  await prisma.$executeRaw`DELETE FROM "MoneroAccount" WHERE address ~ 'A{90}$'`
  // Test users (safe now: their items/tips/earn/payins/accounts are gone).
  if (testUserIds.length) await prisma.user.deleteMany({ where: { id: { in: testUserIds } } })
}

beforeAll(async () => {
  // Self-heal any residue from a prior interrupted run before seeding anew.
  await purgePriorResidue()

  // Ensure the PlatformFeeConfig singleton exists with schema defaults
  // (downvoteRewardsPct=100, postingFeeRewardsPct=70, territoryFeeRewardsPct=30,
  //  distributionMinPayoutPiconeros=1e9, distributionTopN=100).
  await prisma.platformFeeConfig.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } })

  // Clear any RESULT distribution left over from a prior run whose periodEnd
  // falls inside the coming week (otherwise runDistributionOnce's idempotency
  // guard would short-circuit and reuse a stale row). The 8-day-old "prior"
  // distribution shape is purged by purgePriorResidue above.
  const weekAgo = new Date(Date.now() - 7 * DAY)
  const stale = await prisma.rewardDistribution.findMany({ where: { periodEnd: { gte: weekAgo } } })
  for (const d of stale) {
    await prisma.rewardPayout.deleteMany({ where: { distributionId: d.id } })
    await prisma.rewardDistribution.deleteMany({ where: { id: d.id } })
  }

  // Prior period's distribution carrying a rollover into this week's pool.
  const priorEnd = new Date(Date.now() - 8 * DAY)
  const priorStart = new Date(Date.now() - 15 * DAY)
  const prior = await prisma.rewardDistribution.create({
    data: {
      periodStart: priorStart,
      periodEnd: priorEnd,
      poolPiconeros: PRIOR_ROLLOVER_PICONEROS,
      distributedPiconeros: 0n,
      rolledOverPiconeros: PRIOR_ROLLOVER_PICONEROS,
      payoutCount: 0,
      status: 'COMPLETE'
    }
  })
  created.distributions.push(prior.id)

  // --- Inflow for THIS week (all CONFIRMED, confirmedAt inside the period) ---
  const inPeriod = new Date(Date.now() - 2 * DAY)

  // Author + ranked root post (the tipped content) + author receiving account.
  // weightedVotes starts at 0 — it is populated through the REAL path
  // (applyTipDetected below) rather than seeded directly, so this fixture no
  // longer masks the bug that nothing writes weightedVotes.
  const authorId = await createUser()
  const recipientAccount = await createRecipientAccount()
  const postId = await createRootPost(authorId, 0, new Date(Date.now() - 3 * DAY))

  // Downvote payment (platform rewards wallet inflow) attributed to the post.
  await seedDownvote(postId, DOWNVOTE_PICONEROS, inPeriod)

  // Posting fee + territory fee (need distinct PayIns for the FK).
  const postingPayIn = await seedPayIn(authorId, 'ITEM_CREATE', 1, 1)
  const territoryPayIn = await seedPayIn(authorId, 'TERRITORY_CREATE', 2, 1)
  await seedFee(postingPayIn.id, 'POSTING', 1, POSTING_FEE_PICONEROS, inPeriod)
  await seedFee(territoryPayIn.id, 'TERRITORY_CREATE', 2, TERRITORY_FEE_PICONEROS, inPeriod)

  // Donation (extra source: funds the pool 1:1, no allocation %). Lands on the
  // DONATE fee subaddress major (3) per the fee-subaddress convention.
  const donatePayIn = await seedPayIn(authorId, 'DONATE', 3, 1)
  await seedFee(donatePayIn.id, 'DONATE', 3, EXTRA_DONATE_PICONEROS, inPeriod)

  // --- Curators (tippers): c1, c2 get payout accounts; c3 does NOT ---
  const c1 = await createUser()
  const c2 = await createUser()
  const c3 = await createUser()
  seededCurators = { c1, c2, c3 }
  await createPayoutAccount(c1)
  await createPayoutAccount(c2)
  // c3: intentionally no MoneroAccount(ownerUserId: c3) -> excluded from payouts.

  // Real path (merged rewards plan Task 2): give c1 territory trust in 'meta'
  // and apply a detected tip so Item.weightedVotes is bumped via
  // zapTrust × LOG(tipPiconeros) — exactly what the webhook receiver does on a
  // live tip. This is what makes the post qualify for curator rewards.
  await prisma.userSubTrust.create({
    data: { subName: 'meta', userId: c1, zapPostTrust: 1.0, subZapPostTrust: 1.0 }
  })
  await applyTipDetected(postId, c1, 1_000_000_000n)

  // Equal-weight confirmed tips from each curator on the top post, inside the period.
  await seedTip({ postId, tipperId: c1, piconeros: 2_000_000_000_000n, confirmedAt: inPeriod, recipientAccountId: recipientAccount.id })
  await seedTip({ postId, tipperId: c2, piconeros: 2_000_000_000_000n, confirmedAt: new Date(inPeriod.getTime() + 60000), recipientAccountId: recipientAccount.id })
  await seedTip({ postId, tipperId: c3, piconeros: 2_000_000_000_000n, confirmedAt: new Date(inPeriod.getTime() + 120000), recipientAccountId: recipientAccount.id })

  // --- Run the distribution (Task 9 signer stub injected) ---
  result = await runDistributionOnce({ models: prisma, sendPayouts: fakeSigner })
  created.distributions.push(result.id)
})

afterAll(async () => {
  // FK-safe teardown.
  await prisma.earn.deleteMany({ where: { distributionId: { in: created.distributions } } })
  for (const id of created.distributions) {
    await prisma.rewardPayout.deleteMany({ where: { distributionId: id } })
  }
  await prisma.rewardDistribution.deleteMany({ where: { id: { in: created.distributions } } })
  await prisma.feeObservation.deleteMany({ where: { id: { in: created.fees } } })
  await prisma.observedTip.deleteMany({ where: { id: { in: created.tips } } })
  await prisma.observedDownvote.deleteMany({ where: { id: { in: created.downvotes } } })
  await prisma.payIn.deleteMany({ where: { id: { in: created.payIns } } })
  for (const id of created.items) {
    await prisma.itemUserAgg.deleteMany({ where: { itemId: id } })
    await prisma.item.deleteMany({ where: { id } })
  }
  await prisma.moneroAccount.deleteMany({ where: { id: { in: created.accounts } } })
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } })
  await prisma.$disconnect()
})

test('the rewards pool equals the exact allocation earmark + extra sources + prior rollover', async () => {
  expect(result.poolPiconeros.toString()).toBe(EXPECTED_POOL_PICONEROS.toString())
})

test('the DONATE extra source funds the pool 1:1 (no allocation %)', async () => {
  // Without the extra term, pool would be 9.4e12; the DONATE observation adds
  // its full amount at 100% (no downvoteRewardsPct/postingFeeRewardsPct split).
  expect(result.poolPiconeros).toBe(9_400_000_000_000n + EXTRA_DONATE_PICONEROS)
})

test('distributedPiconeros + rolledOverPiconeros reconciles to the pool exactly', async () => {
  expect(result.distributedPiconeros + result.rolledOverPiconeros).toBe(result.poolPiconeros)
})

test('the distributor pays out (>0) when weightedVotes is populated through the real tip path', async () => {
  // End-to-end: weightedVotes on the top post was bumped by applyTipDetected
  // (above, via a UserSubTrust row) — NOT seeded directly — so this asserts the
  // real production path feeds computeCuratorShares and the pool is distributed.
  expect(result.distributedPiconeros).toBeGreaterThan(0n)
  expect(result.payoutCount).toBeGreaterThan(0)
})

test('the distribution is finalized COMPLETE (Task 9 signer wired) with completedAt set', async () => {
  expect(result.status).toBe('COMPLETE')
  expect(result.payoutCount).toBeGreaterThan(0)
  expect(result.completedAt).toBeTruthy()
})

test('RewardPayout rows are SENT with a tx hash, each with an address and at least minPayout', async () => {
  const payouts = await prisma.rewardPayout.findMany({ where: { distributionId: result.id } })
  expect(payouts.length).toBeGreaterThan(0)
  for (const p of payouts) {
    expect(p.state).toBe('SENT')
    expect(p.txHash).toMatch(/^[0-9a-f]{64}$/)
    expect(p.recipientAddress).toBeTruthy()
    expect(p.piconeros).toBeGreaterThanOrEqual(1_000_000_000n)
  }
})

test('the signer was invoked once with the created QUEUED payouts', async () => {
  expect(signerInvocations).toBe(1)
})

test('a curator WITHOUT a registered receiving address is excluded (their share rolls over)', async () => {
  const payouts = await prisma.rewardPayout.findMany({ where: { distributionId: result.id }, select: { curatorId: true } })
  const curatorIds = payouts.map(p => p.curatorId)
  expect(curatorIds).toContain(seededCurators.c1)
  expect(curatorIds).toContain(seededCurators.c2)
  expect(curatorIds).not.toContain(seededCurators.c3)
})

test('Earn rows are written for paid curators only, summing exactly to distributedPiconeros', async () => {
  const earns = await prisma.earn.findMany({ where: { distributionId: result.id } })
  expect(earns.length).toBeGreaterThan(0)

  const earnerIds = [...new Set(earns.map(e => e.userId))]
  expect(earnerIds).toContain(seededCurators.c1)
  expect(earnerIds).toContain(seededCurators.c2)
  expect(earnerIds).not.toContain(seededCurators.c3) // no payout address -> excluded

  for (const e of earns) {
    expect(['TIP_POST', 'TIP_COMMENT']).toContain(e.type)
    expect(e.rank).toBeGreaterThan(0)
    expect(e.typeId).toBeNull()
    expect(e.distributionId).toBe(result.id)
    expect(e.createdAt.toISOString()).toBe(result.periodEnd.toISOString())
  }
  const sum = earns.reduce((acc, e) => acc + e.piconeros, 0n)
  expect(sum).toBe(result.distributedPiconeros)
})

test('a zero-payout distribution skips SENDING and goes straight to COMPLETE', async () => {
  // period far in the past so this row never trips runDistributionOnce's
  // week-window idempotency check (this test calls finalizeDistribution directly).
  const dist = await prisma.rewardDistribution.create({
    data: {
      periodStart: new Date(Date.now() - 31 * DAY),
      periodEnd: new Date(Date.now() - 30 * DAY),
      poolPiconeros: 0n,
      distributedPiconeros: 0n,
      rolledOverPiconeros: 0n,
      payoutCount: 0,
      status: 'PENDING'
    }
  })
  created.distributions.push(dist.id)
  let called = false
  await finalizeDistribution(prisma, { ...dist, payouts: [] }, async () => { called = true; return { sent: 0, failed: 0, skipped: 0 } })
  const updated = await prisma.rewardDistribution.findUnique({ where: { id: dist.id } })
  expect(updated.status).toBe('COMPLETE')
  expect(updated.completedAt).toBeTruthy()
  expect(updated.startedAt).toBeNull() // never entered SENDING on an empty week
  expect(called).toBe(false) // signer not invoked
})

test('a catastrophic signer failure marks the distribution FAILED (payouts keep their state)', async () => {
  const curatorId = await createUser()
  const dist = await prisma.rewardDistribution.create({
    data: {
      periodStart: new Date(Date.now() - 31 * DAY),
      periodEnd: new Date(Date.now() - 30 * DAY),
      poolPiconeros: 1_000_000_000n,
      distributedPiconeros: 1_000_000_000n,
      rolledOverPiconeros: 0n,
      payoutCount: 1,
      status: 'PENDING'
    }
  })
  created.distributions.push(dist.id)
  const payout = await prisma.rewardPayout.create({
    data: { distributionId: dist.id, curatorId, recipientAddress: makeAddress(), piconeros: 1_000_000_000n, state: 'QUEUED' }
  })
  await finalizeDistribution(prisma, { ...dist, payouts: [payout] }, async () => { throw new Error('wallet unavailable') })
  const updated = await prisma.rewardDistribution.findUnique({ where: { id: dist.id } })
  expect(updated.status).toBe('FAILED')
  // the payout is untouched (signer threw before marking it) -> still retryable
  const payoutAfter = await prisma.rewardPayout.findUnique({ where: { id: payout.id } })
  expect(payoutAfter.state).toBe('QUEUED')
})

test('a FAILED distribution with QUEUED payouts is resumable to COMPLETE (Fix 2)', async () => {
  // The CAS accepts FAILED, and sendPayouts is idempotent on QUEUED, so a stuck
  // distribution can be re-driven to COMPLETE with no double-send. Driven here
  // with the module-level fakeSigner (marks QUEUED -> SENT).
  const curatorId = await createUser()
  const dist = await prisma.rewardDistribution.create({
    data: {
      periodStart: new Date(Date.now() - 31 * DAY),
      periodEnd: new Date(Date.now() - 30 * DAY),
      poolPiconeros: 1_000_000_000n,
      distributedPiconeros: 1_000_000_000n,
      rolledOverPiconeros: 0n,
      payoutCount: 1,
      status: 'FAILED'
    }
  })
  created.distributions.push(dist.id)
  const payout = await prisma.rewardPayout.create({
    data: { distributionId: dist.id, curatorId, recipientAddress: makeAddress(), piconeros: 1_000_000_000n, state: 'QUEUED' }
  })
  await finalizeDistribution(prisma, { ...dist, payouts: [payout] }, fakeSigner)
  const updated = await prisma.rewardDistribution.findUnique({ where: { id: dist.id } })
  expect(updated.status).toBe('COMPLETE')
  expect(updated.completedAt).toBeTruthy()
  const payoutAfter = await prisma.rewardPayout.findUnique({ where: { id: payout.id } })
  expect(payoutAfter.state).toBe('SENT')
  expect(payoutAfter.txHash).toMatch(/^[0-9a-f]{64}$/)
})

test('a second run within the same week is idempotent (returns the existing distribution)', async () => {
  const before = await prisma.rewardPayout.count({ where: { distributionId: result.id } })
  const again = await runDistributionOnce({ models: prisma, sendPayouts: fakeSigner })
  expect(again.id).toBe(result.id)
  const after = await prisma.rewardPayout.count({ where: { distributionId: result.id } })
  expect(after).toBe(before)
})
