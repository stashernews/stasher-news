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
//
// The ops-earmark sweep is NOT part of finalization (2026-09-14 decoupling):
// worker/opsSweep.js owns it as a delayed one-shot enqueued by the handler.

import { PrismaClient } from '@prisma/client'
import { runDistributionOnce, finalizeDistribution } from '@/worker/rewardsDistributor'
import { applyTipDetected } from '@/api/monero/ranking'

// The beforeAll hook seeds + runs a real distribution against the live dev DB;
// on a busy stack (residue purge, seeding, curator-share computation) it can
// exceed Jest's 5s default. Give the hooks headroom.
jest.setTimeout(30000)

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
let genuineRewardsShare // rewards share of genuine (non-fixture) inflow in the period (beforeAll)
let genuineOpsShare // ops share of genuine (non-fixture) inflow in the period (beforeAll)
let priorTrustFloor = null

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
//   rewardsInflow = 5e12*100/100 + 4e12*70/100 + 2e12*30/100
//                 + 3e12 (DONATE @100%) + 1e12*50/100 (DONATE @50%)
//                 + 1e12*30/100 (BOOST @30%) + 2e12*70/100 (TIP_UNWALLETED @70%)
//                 + 2.5e12 (BOUNTY_ROLLOVER @100%)
//                 = 5e12 + 2.8e12 + 0.6e12 + 3e12 + 0.5e12 + 0.3e12 + 1.4e12 + 2.5e12 = 16.1e12
//   pool          = 16.1e12 + 1e12 (prior rollover) = 17.1e12
//   totalInflow   = rewardsInflow + 0.5e12 (BOUNTY_FEE @0% rewards, 100% ops)
//                 = 21e12
//   opsInflow     = totalInflow - rewardsInflow = 0.5e12 (BOUNTY_FEE) + 1.2e12 (posting)
//                   + 1.4e12 (territory) + 0.5e12 (half DONATE) + 0.7e12 (BOOST)
//                   + 0.6e12 (TIP_UNWALLETED) = 4.9e12
const DOWNVOTE_PICONEROS = 5_000_000_000_000n
const POSTING_FEE_PICONEROS = 4_000_000_000_000n
const TERRITORY_FEE_PICONEROS = 2_000_000_000_000n
const EXTRA_DONATE_PICONEROS = 3_000_000_000_000n
const HALF_DONATE_PICONEROS = 1_000_000_000_000n // 1e12, donationRewardsPct=50 -> 0.5e12 pool / 0.5e12 ops
const BOOST_FEE_PICONEROS = 1_000_000_000_000n
const PRIOR_ROLLOVER_PICONEROS = 1_000_000_000_000n
const WALLETLESS_TIP_PICONEROS = 2_000_000_000_000n
const BOUNTY_ROLLOVER_PICONEROS = 2_500_000_000_000n
const BOUNTY_FEE_PICONEROS = 500_000_000_000n
const EXPECTED_POOL_PICONEROS = 17_100_000_000_000n
// Ops earmark = totalInflow - rewardsInflow.
//   downvote (100% rewards -> 0 ops) + posting 4e12*30% + territory 2e12*70% + donate 1e12*50% (half) + boost 1e12*70% + walletless 2e12*30% + bounty rollover (100% rewards -> 0 ops) + bounty fee (100% ops) = 1.2e12 + 1.4e12 + 0.5e12 + 0.7e12 + 0.6e12 + 0.5e12 = 4.9e12
const EXPECTED_OPS_INFLOW_PICONEROS = 4_900_000_000_000n

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
async function seedFee (payInId, feeType, major, piconeros, confirmedAt, donationRewardsPct = undefined) {
  feeSeq += 1
  const fee = await prisma.feeObservation.create({
    data: {
      txHash: 'rdfee' + String(feeSeq),
      payInId,
      feeType,
      recipientMajor: major,
      recipientMinor: feeSeq,
      piconeros,
      donationRewardsPct,
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
  // Fee subaddresses before the accounts they lock: an interrupted fee-pool
  // test can leave SubaddressIndex rows on A{90}$ accounts, which would abort
  // the account delete below on SubaddressIndex_accountId_fkey.
  await prisma.$executeRaw`DELETE FROM "SubaddressIndex" WHERE "accountId" IN (SELECT id FROM "MoneroAccount" WHERE address ~ 'A{90}$')`
  await prisma.$executeRaw`DELETE FROM "MoneroAccount" WHERE address ~ 'A{90}$'`
  // Test users (safe now: their items/tips/earn/payins/accounts are gone).
  if (testUserIds.length) await prisma.user.deleteMany({ where: { id: { in: testUserIds } } })
}

beforeAll(async () => {
  // Self-heal any residue from a prior interrupted run before seeding anew.
  await purgePriorResidue()

  // Snapshot the operator's floor so afterAll can restore it — this suite
  // runs against the shared dev DB and must leave no trace (AGENTS norm).
  const priorConfigRow = await prisma.platformFeeConfig.findUnique({ where: { id: 1 } })
  priorTrustFloor = priorConfigRow?.curatorTrustWeightFloor ?? null

  // Ensure the PlatformFeeConfig singleton exists with schema defaults
  // (downvoteRewardsPct=100, postingFeeRewardsPct=70, territoryFeeRewardsPct=30,
  //  distributionMinPayoutPiconeros=1e9, distributionTopN=10).
  // curatorTrustWeightFloor is PINNED to 1.0 for this suite: only c1 has a
  // seeded UserSubTrust row, so any other floor would discount c2/c3 and break
  // the exact-pool assertions regardless of operator config.
  await prisma.platformFeeConfig.upsert({ where: { id: 1 }, update: { curatorTrustWeightFloor: 1.0 }, create: { id: 1 } })

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

  // A second donation with a payer-chosen 50% rewards split (fee-allocation v2).
  const halfDonatePayIn = await seedPayIn(authorId, 'DONATE', 3, 2)
  await seedFee(halfDonatePayIn.id, 'DONATE', 3, HALF_DONATE_PICONEROS, inPeriod, 50)

  // Boost (boostRewardsPct, default 30): funds the pool at 30%, the other 70%
  // is ops. Lands on the BOOST fee subaddress major (5) per the fee-subaddress
  // convention.
  const boostPayIn = await seedPayIn(authorId, 'BOOST', 5, 1)
  await seedFee(boostPayIn.id, 'BOOST', 5, BOOST_FEE_PICONEROS, inPeriod)

  // Wallet-less-author tip (TIP_UNWALLETED): funds the pool at
  // walletlessTipRewardsPct (default 70). Lands on its dedicated major-4
  // subaddress; payInId is null because a wallet-less tip creates no PayIn.
  await seedFee(null, 'TIP_UNWALLETED', 4, WALLETLESS_TIP_PICONEROS, inPeriod)

  // Bounty rollover (BOUNTY_ROLLOVER): the escrow's bounty portion physically
  // arrived at the rewards wallet — funds the pool 100% (no allocation %).
  // payInId is null because a rollover creates no PayIn.
  await seedFee(null, 'BOUNTY_ROLLOVER', 0, BOUNTY_ROLLOVER_PICONEROS, inPeriod)

  // Bounty fee (BOUNTY_FEE): booked at funding confirmation and physically
  // riding along the rollover tx — 100% ops (0% pool).
  await seedFee(null, 'BOUNTY_FEE', 0, BOUNTY_FEE_PICONEROS, inPeriod)

  // --- Curators (tippers): c1, c2 get payout accounts; c3 does NOT ---
  const c1 = await createUser()
  const c2 = await createUser()
  const c3 = await createUser()
  seededCurators = { c1, c2, c3 }
  await createPayoutAccount(c1)
  await createPayoutAccount(c2)
  // c3: intentionally no MoneroAccount(ownerUserId: c3) -> excluded from payouts.

  // Real path (merged rewards plan Task 2): give c1 territory trust in 'stasher'
  // and apply a detected tip so Item.weightedVotes is bumped via
  // zapTrust × LOG(tipPiconeros) — exactly what the webhook receiver does on a
  // live tip. This is what makes the post qualify for curator rewards.
  await prisma.userSubTrust.create({
    data: { subName: 'stasher', userId: c1, zapPostTrust: 1.0, subZapPostTrust: 1.0 }
  })
  await applyTipDetected(postId, c1, 1_000_000_000n)

  // Equal-weight confirmed tips from each curator on the top post, inside the period.
  await seedTip({ postId, tipperId: c1, piconeros: 2_000_000_000_000n, confirmedAt: inPeriod, recipientAccountId: recipientAccount.id })
  await seedTip({ postId, tipperId: c2, piconeros: 2_000_000_000_000n, confirmedAt: new Date(inPeriod.getTime() + 60000), recipientAccountId: recipientAccount.id })
  await seedTip({ postId, tipperId: c3, piconeros: 2_000_000_000_000n, confirmedAt: new Date(inPeriod.getTime() + 120000), recipientAccountId: recipientAccount.id })

  // --- Run the distribution (Task 9 signer stub injected) ---
  result = await runDistributionOnce({ models: prisma, sendPayouts: fakeSigner })
  created.distributions.push(result.id)

  // Genuine (non-fixture) confirmed inflow inside the distribution's period:
  // the suite assumes it is the sole inflow source (AGENTS.md), but real
  // stagenet activity on the dev stack (posting fees, downvotes) lands in the
  // window and breaks the absolute pool constants. Recompute its rewards share
  // by source — excluding the rdfee/rddv fixture prefixes, grouping territory
  // types before the split exactly like the distributor — and fold it into the
  // expected-pool math below (the drift-robust pattern of the opsInflow test).
  // The seeded sources stay pinned exactly.
  const configRow = await prisma.platformFeeConfig.findUnique({ where: { id: 1 } })
  const genuineFeeGroups = await prisma.feeObservation.groupBy({
    by: ['feeType'],
    _sum: { piconeros: true },
    where: {
      state: 'CONFIRMED',
      confirmedAt: { gte: result.periodStart, lt: result.periodEnd },
      txHash: { not: { startsWith: 'rdfee' } }
    }
  })
  const genuineFees = Object.fromEntries(genuineFeeGroups.map(g => [g.feeType, g._sum.piconeros ?? 0n]))
  const genuineDownvotes = (await prisma.observedDownvote.aggregate({
    _sum: { piconeros: true },
    where: {
      state: 'CONFIRMED',
      confirmedAt: { gte: result.periodStart, lt: result.periodEnd },
      txHash: { not: { startsWith: 'rddv' } }
    }
  }))._sum.piconeros ?? 0n
  // Genuine donations may carry their own per-donation pct (not the rdfee
  // prefix), so weight them like the distributor does.
  const genuineDonateRewards = (await prisma.$queryRaw`
    SELECT COALESCE(sum("piconeros" * COALESCE("donationRewardsPct", 100) / 100), 0)::bigint AS s
    FROM "FeeObservation"
    WHERE "feeType" = 'DONATE' AND state = 'CONFIRMED'
      AND "confirmedAt" >= ${result.periodStart} AND "confirmedAt" < ${result.periodEnd}
      AND "txHash" NOT LIKE 'rdfee%'`)[0].s ?? 0n
  const split = (feeType, pct) => (genuineFees[feeType] ?? 0n) * BigInt(pct) / 100n
  const territorySum = (genuineFees.TERRITORY_CREATE ?? 0n) + (genuineFees.TERRITORY_BILLING ?? 0n) + (genuineFees.TERRITORY_UNARCHIVE ?? 0n) + (genuineFees.TERRITORY_UPDATE ?? 0n)
  genuineRewardsShare =
    genuineDownvotes +
    split('POSTING', configRow.postingFeeRewardsPct) +
    territorySum * BigInt(configRow.territoryFeeRewardsPct) / 100n +
    genuineDonateRewards +
    split('BOOST', configRow.boostRewardsPct) +
    split('TIP_UNWALLETED', configRow.walletlessTipRewardsPct) +
    (genuineFees.BOUNTY_ROLLOVER ?? 0n)

  // Genuine ops share: totalInflow − rewardsInflow mirrors the distributor's
  // opsInflow = totalInflow − rewardsInflow definition, so genuine stagenet
  // activity on the dev DB (e.g. a real posting fee) doesn't break the
  // 50/50-split ops assertion (AGENTS.md drift-robust pattern).
  const genuineFeesTotal = genuineFeeGroups.reduce((acc, g) => acc + (g._sum.piconeros ?? 0n), 0n)
  const genuineTotalInflow = genuineDownvotes + genuineFeesTotal
  genuineOpsShare = genuineTotalInflow - genuineRewardsShare
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

  // Restore the operator's pre-suite floor (leave-no-trace on the shared dev
  // DB). If this suite's pin CREATED the singleton row, leave it with schema
  // defaults — semantically identical to the pre-suite world. A killed run
  // skips this restore (documented residue, same class as fixture residue).
  await prisma.platformFeeConfig.upsert({
    where: { id: 1 },
    update: { curatorTrustWeightFloor: priorTrustFloor ?? 1.0 },
    create: { id: 1 }
  })

  await prisma.$disconnect()
})

test('the rewards pool equals the exact allocation earmark + extra sources + prior rollover', async () => {
  expect(result.poolPiconeros.toString()).toBe((EXPECTED_POOL_PICONEROS + genuineRewardsShare).toString())
})

test('DONATE sources fund the pool at their per-donation rewards pct', async () => {
  // The 3e12 fixture donation (no pct -> 100% pool) plus the 1e12 fixture
  // donation at 50% (0.5e12 pool), on top of the 9.4e12 base pool.
  expect(result.poolPiconeros).toBe(9_400_000_000_000n + EXTRA_DONATE_PICONEROS + HALF_DONATE_PICONEROS * 50n / 100n + BOOST_FEE_PICONEROS * 30n / 100n + WALLETLESS_TIP_PICONEROS * 70n / 100n + BOUNTY_ROLLOVER_PICONEROS + genuineRewardsShare)
})

test('a donation with donationRewardsPct=50 splits 50/50 into pool and ops', async () => {
  const poolWithoutHalf = EXPECTED_POOL_PICONEROS + genuineRewardsShare - HALF_DONATE_PICONEROS * 50n / 100n
  expect(result.poolPiconeros - poolWithoutHalf).toBe(HALF_DONATE_PICONEROS * 50n / 100n)
  const opsWithoutHalf = EXPECTED_OPS_INFLOW_PICONEROS + genuineOpsShare - HALF_DONATE_PICONEROS * 50n / 100n
  expect(result.opsInflowPiconeros - opsWithoutHalf).toBe(HALF_DONATE_PICONEROS * 50n / 100n)
})

test('the BOUNTY_ROLLOVER source funds the pool 100% and BOUNTY_FEE funds it 0% (ops-only)', async () => {
  // The rollover's bounty portion arrives at the rewards wallet — 100% pool.
  const poolWithoutBountyRollover = EXPECTED_POOL_PICONEROS + genuineRewardsShare - BOUNTY_ROLLOVER_PICONEROS
  expect(result.poolPiconeros - poolWithoutBountyRollover).toBe(BOUNTY_ROLLOVER_PICONEROS)
  // The fee was booked at funding (BOUNTY_FEE, 100% ops) and physically rides
  // along the rollover — it must NOT inflate the pool: the pool equals the
  // expected total WITHOUT the fee term (were the fee booked to the pool, the
  // pool would be BOUNTY_FEE_PICONEROS higher).
  expect(result.poolPiconeros).toBe(EXPECTED_POOL_PICONEROS + genuineRewardsShare)
})

test('the BOOST source funds the pool at boostRewardsPct (30%), not 100%', async () => {
  // If BOOST were lumped into the 100% extra bucket (the old behavior), the
  // pool would be EXPECTED_POOL_PICONEROS + BOOST_FEE_PICONEROS * 30n / 100n
  // higher than it should be. Pin the exact 30% contribution.
  const poolWithoutBoost = EXPECTED_POOL_PICONEROS + genuineRewardsShare - BOOST_FEE_PICONEROS * 30n / 100n
  expect(result.poolPiconeros - poolWithoutBoost).toBe(BOOST_FEE_PICONEROS * 30n / 100n)
  expect(BOOST_FEE_PICONEROS * 30n / 100n).toBe(300_000_000_000n)
})

test('the TIP_UNWALLETED source funds the pool at walletlessTipRewardsPct (70%), not 100%', async () => {
  // If TIP_UNWALLETED were lumped into the 100% extra bucket (the old behavior),
  // the pool would be EXPECTED_POOL_PICONEROS + WALLETLESS_TIP_PICONEROS * 70n / 100n
  // higher than it should be. Pin the exact 70% contribution.
  const poolWithoutWalletless = EXPECTED_POOL_PICONEROS + genuineRewardsShare - WALLETLESS_TIP_PICONEROS * 70n / 100n
  expect(result.poolPiconeros - poolWithoutWalletless).toBe(WALLETLESS_TIP_PICONEROS * 70n / 100n)
  expect(WALLETLESS_TIP_PICONEROS * 70n / 100n).toBe(1_400_000_000_000n)
})

test('distributedPiconeros + rolledOverPiconeros reconciles to the pool exactly', async () => {
  expect(result.distributedPiconeros + result.rolledOverPiconeros).toBe(result.poolPiconeros)
})

test('opsInflowPiconeros is the exact complement of the rewards earmark (totalInflow - rewardsInflow)', async () => {
  // Drift-robust: recompute the period's actual confirmed inflow from the DB
  // (genuine stagenet activity may add to the pool on the live dev DB).
  const dv = await prisma.observedDownvote.aggregate({ _sum: { piconeros: true }, where: { state: 'CONFIRMED', confirmedAt: { gte: result.periodStart, lt: result.periodEnd } } })
  const fees = await prisma.feeObservation.aggregate({ _sum: { piconeros: true }, where: { state: 'CONFIRMED', confirmedAt: { gte: result.periodStart, lt: result.periodEnd } } })
  const totalInflow = (dv._sum.piconeros ?? 0n) + (fees._sum.piconeros ?? 0n)
  // rewardsInflow is definitional: pool = rewardsInflow + priorRolledOver.
  const rewardsInflow = result.poolPiconeros - PRIOR_ROLLOVER_PICONEROS
  expect(result.opsInflowPiconeros).toBe(totalInflow - rewardsInflow)
  // Sanity: the walletless-tip ops share (30% of 2e12 = 0.6e12) is included.
  expect(result.opsInflowPiconeros).toBeGreaterThanOrEqual(EXPECTED_OPS_INFLOW_PICONEROS)
})

test('opsAvailablePiconeros equals opsInflow + opsRolledOver (prior had no ops, so rollover is 0)', async () => {
  expect(result.opsRolledOverPiconeros).toBe(0n)
  expect(result.opsAvailablePiconeros).toBe(result.opsInflowPiconeros + result.opsRolledOverPiconeros)
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

test('a signer SKIP (insufficient unlocked) leaves the distribution FAILED — never COMPLETE (2026-08-24 fix)', async () => {
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
  await finalizeDistribution(
    prisma,
    { ...dist, payouts: [payout] },
    async () => ({ sent: 0, failed: 0, skipped: 1 }))
  const updated = await prisma.rewardDistribution.findUnique({ where: { id: dist.id } })
  expect(updated.status).toBe('FAILED')
  expect(updated.completedAt).toBeNull()
  const payoutAfter = await prisma.rewardPayout.findUnique({ where: { id: payout.id } })
  expect(payoutAfter.state).toBe('QUEUED') // resumable
})

test('a partial send (sent > 0, skipped > 0) also marks the distribution FAILED (resumable)', async () => {
  const curatorId = await createUser()
  const dist = await prisma.rewardDistribution.create({
    data: {
      periodStart: new Date(Date.now() - 32 * DAY),
      periodEnd: new Date(Date.now() - 31 * DAY),
      poolPiconeros: 2_000_000_000n,
      distributedPiconeros: 2_000_000_000n,
      rolledOverPiconeros: 0n,
      payoutCount: 2,
      status: 'PENDING'
    }
  })
  created.distributions.push(dist.id)
  const payouts = []
  for (let i = 0; i < 2; i++) {
    payouts.push(await prisma.rewardPayout.create({
      data: { distributionId: dist.id, curatorId, recipientAddress: makeAddress(), piconeros: 1_000_000_000n, state: 'QUEUED' }
    }))
  }
  await finalizeDistribution(
    prisma,
    { ...dist, payouts },
    async (rows, { models }) => {
      await models.rewardPayout.update({ where: { id: rows[0].id }, data: { state: 'SENT', txHash: 'ab'.repeat(32) } })
      return { sent: 1, failed: 0, skipped: 1 }
    })
  const updated = await prisma.rewardDistribution.findUnique({ where: { id: dist.id } })
  expect(updated.status).toBe('FAILED')
  const p0 = await prisma.rewardPayout.findUnique({ where: { id: payouts[0].id } })
  const p1 = await prisma.rewardPayout.findUnique({ where: { id: payouts[1].id } })
  expect(p0.state).toBe('SENT')
  expect(p1.state).toBe('QUEUED')
})

test('a signer hard-failure summary (failed > 0) marks the distribution FAILED too', async () => {
  const curatorId = await createUser()
  const dist = await prisma.rewardDistribution.create({
    data: {
      periodStart: new Date(Date.now() - 33 * DAY),
      periodEnd: new Date(Date.now() - 32 * DAY),
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
  await finalizeDistribution(
    prisma,
    { ...dist, payouts: [payout] },
    async (rows, { models }) => {
      await models.rewardPayout.update({ where: { id: rows[0].id }, data: { state: 'FAILED' } })
      return { sent: 0, failed: 1, skipped: 0 }
    })
  const updated = await prisma.rewardDistribution.findUnique({ where: { id: dist.id } })
  expect(updated.status).toBe('FAILED')
})

test('an unpersisted relay (sent>0, unpersisted>0) marks the distribution FAILED — never COMPLETE (audit #6)', async () => {
  const curatorId = await createUser()
  const dist = await prisma.rewardDistribution.create({
    data: {
      periodStart: new Date(Date.now() - 34 * DAY),
      periodEnd: new Date(Date.now() - 33 * DAY),
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
  await finalizeDistribution(
    prisma,
    { ...dist, payouts: [payout] },
    async () => ({ sent: 1, failed: 0, skipped: 0, unpersisted: 1 }))
  const updated = await prisma.rewardDistribution.findUnique({ where: { id: dist.id } })
  expect(updated.status).toBe('FAILED')
  expect(updated.completedAt).toBeNull()
  const payoutAfter = await prisma.rewardPayout.findUnique({ where: { id: payout.id } })
  expect(payoutAfter.state).toBe('QUEUED')
})

test('a FAILED distribution with all payouts SENT reconciles to COMPLETE on the next run (finalize is sweep-agnostic)', async () => {
  const curatorId = await createUser()
  const dist = await prisma.rewardDistribution.create({
    data: {
      periodStart: new Date(Date.now() - 31 * DAY),
      periodEnd: new Date(Date.now() - 30 * DAY),
      poolPiconeros: 1_000_000_000n,
      distributedPiconeros: 1_000_000_000n,
      rolledOverPiconeros: 0n,
      opsAvailablePiconeros: 2_000_000_000n,
      payoutCount: 1,
      opsSweepState: 'FAILED',
      status: 'FAILED'
    }
  })
  created.distributions.push(dist.id)
  const payout = await prisma.rewardPayout.create({
    data: { distributionId: dist.id, curatorId, recipientAddress: makeAddress(), piconeros: 1_000_000_000n, state: 'SENT', txHash: 'ab'.repeat(32) }
  })
  let signerCalled = false
  await finalizeDistribution(
    prisma,
    { ...dist, payouts: [payout] },
    async () => { signerCalled = true; return { sent: 0, failed: 0, skipped: 0 } })
  const updated = await prisma.rewardDistribution.findUnique({ where: { id: dist.id } })
  expect(updated.status).toBe('COMPLETE')
  expect(updated.completedAt).toBeTruthy()
  expect(updated.opsSweepState).toBe('FAILED') // untouched — finalize never sweeps
  expect(signerCalled).toBe(false) // !hasQueued branch skips the signer
})

test('a second run within the same week is idempotent (returns the existing distribution)', async () => {
  const before = await prisma.rewardPayout.count({ where: { distributionId: result.id } })
  const again = await runDistributionOnce({ models: prisma, sendPayouts: fakeSigner })
  expect(again.id).toBe(result.id)
  const after = await prisma.rewardPayout.count({ where: { distributionId: result.id } })
  expect(after).toBe(before)
})

test('referred curators produce a FOREVER_REFERRAL payout + Earn row for the referrer', async () => {
  // The beforeAll distribution occupies this week's window, so
  // runDistributionOnce's idempotency guard would return it verbatim. Clear it
  // (Earn -> payout -> distribution, FK-safe) so this test's run writes a fresh
  // distribution for the same week. afterAll's deleteMany on the already-cleared
  // result.id is a harmless no-op.
  await prisma.earn.deleteMany({ where: { distributionId: result.id } })
  await prisma.rewardPayout.deleteMany({ where: { distributionId: result.id } })
  await prisma.rewardDistribution.deleteMany({ where: { id: result.id } })

  const referrer = await createUser()
  await createPayoutAccount(referrer) // referrer must be able to RECEIVE
  const curator = await createUser()
  await prisma.user.update({ where: { id: curator }, data: { referrerId: referrer } })
  await createPayoutAccount(curator)

  // Filler curator: NO payout account, tips the same post — their share rolls
  // over and funds the referral budget, making the 10% referral payout exact.
  const filler = await createUser()

  const recipientAccount = await createRecipientAccount()
  // weightedVotes 1e6 >> the beforeAll post (~20.7 from applyTipDetected) and
  // any dev posts, so competing curators land sub-minPayout shares and don't
  // erode the pool/referral budget.
  const post = await createRootPost(curator, 1_000_000, new Date(Date.now() - DAY))
  await seedTip({ postId: post, tipperId: curator, piconeros: 1_000_000_000n, confirmedAt: new Date(Date.now() - DAY + 1000), recipientAccountId: recipientAccount.id })
  await seedTip({ postId: post, tipperId: filler, piconeros: 1_000_000_000n, confirmedAt: new Date(Date.now() - DAY + 61000), recipientAccountId: recipientAccount.id })

  // stub signer: marks QUEUED -> SENT; no sweep exists in the finalize path
  const dist = await runDistributionOnce({ models: prisma, sendPayouts: fakeSigner })
  created.distributions.push(dist.id)

  const curatorPayout = dist.payouts.find(p => p.curatorId === curator)
  expect(curatorPayout).toBeDefined()
  expect(curatorPayout.state).toBe('SENT')

  const referralPayout = dist.payouts.find(p => p.curatorId === referrer)
  expect(referralPayout).toBeDefined()
  // 10% of the curator's share
  expect(referralPayout.piconeros).toBe(curatorPayout.piconeros / 10n)

  const earn = await prisma.earn.findFirst({
    where: { userId: referrer, type: 'FOREVER_REFERRAL', distributionId: dist.id }
  })
  expect(earn).not.toBeNull()
  expect(earn.piconeros).toBe(referralPayout.piconeros)
  expect(earn.rank).toBeNull()
  expect(earn.typeId).toBeNull()
})

test('a referrer who is ALSO a paid curator gets exactly one FOREVER_REFERRAL Earn (no double-write, no self-inflation)', async () => {
  // The first dedicated referral test's distribution occupies this week's
  // window, so runDistributionOnce's idempotency guard would return it verbatim.
  // Clear it (Earn -> payout -> distribution, FK-safe) so this test's run writes
  // a fresh distribution for the same week. afterAll's deleteMany on the
  // already-cleared id is a harmless no-op.
  const current = await prisma.rewardDistribution.findFirst({ where: { periodEnd: { gte: new Date(Date.now() - 7 * DAY) } } })
  if (current) {
    await prisma.earn.deleteMany({ where: { distributionId: current.id } })
    await prisma.rewardPayout.deleteMany({ where: { distributionId: current.id } })
    await prisma.rewardDistribution.deleteMany({ where: { id: current.id } })
  }

  const author = await createUser()
  const referrer = await createUser() // BOTH a referrer AND a paid curator below
  await createPayoutAccount(referrer)
  const curator = await createUser()
  await prisma.user.update({ where: { id: curator }, data: { referrerId: referrer } })
  await createPayoutAccount(curator)
  // Filler curator: NO payout account, tips the same post — their share rolls
  // over and funds the referral budget (same pattern as the first dedicated
  // referral test), keeping the 10% referral payout exact.
  const filler = await createUser()

  const recipientAccount = await createRecipientAccount()
  // weightedVotes 2e6: strictly outranks the first dedicated referral test's
  // post (1e6) and the beforeAll post, so the NTILE(100) cutoff can't split the
  // two sibling test posts arbitrarily — this post is unambiguously the top
  // post and the only one whose curators clear minPayout, and it dwarfs any dev
  // post so competing curators roll over rather than eroding the budget.
  const post = await createRootPost(author, 2_000_000, new Date(Date.now() - DAY))
  // Equal tips from referrer + curator + filler, staggered confirmedAt. The
  // referrer tipping makes them a PAID CURATOR too — that is the overlap under
  // test (same userId owning both a curator payout row and a referral payout row).
  await seedTip({ postId: post, tipperId: referrer, piconeros: 1_000_000_000n, confirmedAt: new Date(Date.now() - DAY + 1000), recipientAccountId: recipientAccount.id })
  await seedTip({ postId: post, tipperId: curator, piconeros: 1_000_000_000n, confirmedAt: new Date(Date.now() - DAY + 61000), recipientAccountId: recipientAccount.id })
  await seedTip({ postId: post, tipperId: filler, piconeros: 1_000_000_000n, confirmedAt: new Date(Date.now() - DAY + 121000), recipientAccountId: recipientAccount.id })

  const dist = await runDistributionOnce({ models: prisma, sendPayouts: fakeSigner })
  created.distributions.push(dist.id)

  // --- Both payout-row kinds for the SAME user id: the overlap under test ---
  const curatorPayout = dist.payouts.find(p => p.curatorId === curator)
  expect(curatorPayout).toBeDefined()
  const referrerRows = dist.payouts.filter(p => p.curatorId === referrer)
  expect(referrerRows).toHaveLength(2) // curator share payout + referral payout
  const referralPayout = referrerRows.find(p => p.piconeros === curatorPayout.piconeros / 10n)
  expect(referralPayout).toBeDefined()
  const referrerCuratorPayout = referrerRows.find(p => p.piconeros !== curatorPayout.piconeros / 10n)
  expect(referrerCuratorPayout).toBeDefined()

  // 1. Exactly ONE FOREVER_REFERRAL Earn row, worth the referral payout (10% of
  //    the referred curator's share — NOT the referrer's own curator share).
  const referralEarns = await prisma.earn.findMany({
    where: { userId: referrer, type: 'FOREVER_REFERRAL', distributionId: dist.id }
  })
  expect(referralEarns).toHaveLength(1)
  expect(referralEarns[0].piconeros).toBe(referralPayout.piconeros)
  expect(referralEarns[0].piconeros).toBe(curatorPayout.piconeros / 10n)

  // 2. The inflation case is gone: no FOREVER_REFERRAL Earn row carries the
  //    referrer's own curator share (old Loop-2 emitted one at that piconeros).
  const inflated = await prisma.earn.findMany({
    where: { type: 'FOREVER_REFERRAL', distributionId: dist.id, piconeros: referrerCuratorPayout.piconeros }
  })
  expect(inflated).toHaveLength(0)

  // 3. Curator Earn rows (TIP_POST) are written EXACTLY ONCE per paid curator —
  //    the double-write (old Loop-1 re-matching the referral row via shares.find)
  //    would bump the referrer's count to 2.
  const referrerTipEarns = await prisma.earn.findMany({ where: { userId: referrer, type: 'TIP_POST', distributionId: dist.id } })
  expect(referrerTipEarns).toHaveLength(1)
  expect(referrerTipEarns[0].piconeros).toBe(referrerCuratorPayout.piconeros)
  const curatorTipEarns = await prisma.earn.findMany({ where: { userId: curator, type: 'TIP_POST', distributionId: dist.id } })
  expect(curatorTipEarns).toHaveLength(1)
  expect(curatorTipEarns[0].piconeros).toBe(curatorPayout.piconeros)

  // 4. The plan's invariant: sum(Earn) === distributedPiconeros.
  const allEarns = await prisma.earn.findMany({ where: { distributionId: dist.id } })
  const total = allEarns.reduce((acc, e) => acc + e.piconeros, 0n)
  expect(total).toBe(dist.distributedPiconeros)
})

test('a previous weekly run whose periodEnd sits at this run\'s periodStart boundary does not skip (no jitter coin flip)', async () => {
  // Regression: the guard compared periodEnd >= periodStart with zero slack.
  // Consecutive weekly runs land L1/L2 ms after Monday 00:00 UTC (pg-boss
  // pickup latency); when L1 >= L2 the previous run's periodEnd sits ON or
  // INSIDE this run's periodStart and the weekly run silently skipped. Seed
  // the exact collision: a "previous run" whose periodEnd is 4s inside this
  // run's periodStart (previous Monday fired 4s later in its minute than
  // this run does). It must proceed, not return the boundary row.
  //
  // Purge any same-week distribution first (the referral tests above left
  // one behind — same FK-safe pattern as the line-841 cleanup; afterAll's
  // deleteMany on already-deleted ids is a harmless no-op).
  const weekAgo = new Date(Date.now() - 7 * DAY)
  const current = await prisma.rewardDistribution.findMany({ where: { periodEnd: { gte: weekAgo } } })
  for (const d of current) {
    await prisma.earn.deleteMany({ where: { distributionId: d.id } })
    await prisma.rewardPayout.deleteMany({ where: { distributionId: d.id } })
    await prisma.rewardDistribution.deleteMany({ where: { id: d.id } })
  }

  // Previous weekly run: periodEnd 4s AFTER this run's periodStart — the
  // L1 >= L2 collision that used to skip.
  const boundary = await prisma.rewardDistribution.create({
    data: {
      periodStart: new Date(Date.now() - 14 * DAY + 4000),
      periodEnd: new Date(Date.now() - 7 * DAY + 4000),
      poolPiconeros: 0n,
      distributedPiconeros: 0n,
      rolledOverPiconeros: 0n,
      payoutCount: 0,
      status: 'COMPLETE'
    }
  })
  created.distributions.push(boundary.id)

  const dist = await runDistributionOnce({ models: prisma, sendPayouts: fakeSigner })
  created.distributions.push(dist.id)

  expect(dist.id).not.toBe(boundary.id)
  const rows = await prisma.rewardDistribution.findMany({ where: { id: { in: [boundary.id, dist.id] } } })
  expect(rows).toHaveLength(2) // two consecutive weekly runs -> two rows
})

test('a run later in the same week still skips when a distribution ended mid-week (grace must not enable double-payouts)', async () => {
  // The complement of the boundary test: a distribution that ran 3 days ago
  // (periodEnd well inside this week's window) must still short-circuit the
  // run. Guards against over-correcting the boundary bug in the other
  // direction (the rejected periodStart-gte fix double-distributed here).
  // Purge the boundary test's rows first (same FK-safe pattern).
  const weekAgo = new Date(Date.now() - 7 * DAY)
  const current = await prisma.rewardDistribution.findMany({ where: { periodEnd: { gte: weekAgo } } })
  for (const d of current) {
    await prisma.earn.deleteMany({ where: { distributionId: d.id } })
    await prisma.rewardPayout.deleteMany({ where: { distributionId: d.id } })
    await prisma.rewardDistribution.deleteMany({ where: { id: d.id } })
  }

  const earlierThisWeek = await prisma.rewardDistribution.create({
    data: {
      periodStart: new Date(Date.now() - 10 * DAY),
      periodEnd: new Date(Date.now() - 3 * DAY),
      poolPiconeros: 0n,
      distributedPiconeros: 0n,
      rolledOverPiconeros: 0n,
      payoutCount: 0,
      status: 'COMPLETE'
    }
  })
  created.distributions.push(earlierThisWeek.id)

  const again = await runDistributionOnce({ models: prisma, sendPayouts: fakeSigner })
  expect(again.id).toBe(earlierThisWeek.id) // found -> returned verbatim, no new row
  expect(again.status).toBe('COMPLETE') // finalizeDistribution early-returns on COMPLETE
})
