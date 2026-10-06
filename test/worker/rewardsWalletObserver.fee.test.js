/* eslint-env jest */

// Integration test for the rewardsWalletObserver fee-attribution branch (Phase 3 Task 5).
//
// runRewardsWalletObserverOnce is the testable core: it processes rewards-wallet outputs
// and, for each output at a fee subaddress (major 1 = posting, 2 = territory),
// idempotently records a FeeObservation, links it to the pending PayIn, and flips
// the gated Item.feeStatus PENDING_FEE -> FEE_PAID (so the post goes live). The
// pluggable payment_id -> downvote branch is the documented Phase 4 extension
// point and is left as a no-op here.
//
// txs are passed in directly (the pg-boss handler fetches them via lwsClient), so
// no network is touched. Everything else is real DB behaviour against a live,
// migrated database, mirroring test/worker/confirmFinalizer.test.js.

import { PrismaClient } from '@prisma/client'
import { runRewardsWalletObserverOnce, findRewardsAccount } from '@/worker/rewardsWalletObserver'
import { alert } from '@/lib/alert'
import { logError } from '@/lib/logger'
import { sweepFakeRewardsWallets } from '../helpers/sweepRewardsWallets'

// The flip-time quota bookkeeping is guarded by flipPendingToLive (it logs +
// alerts instead of wedging the observer); mock those sinks so the findings-6
// surfacing assertions below can pin them without network/log noise. Mirrors
// rewardsWalletObserver.flip.test.js.
jest.mock('../../lib/alert', () => ({ __esModule: true, alert: jest.fn() }))
jest.mock('../../lib/logger', () => ({
  __esModule: true,
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}))

const prisma = new PrismaClient()

const REWARDS_ADDR = '5RpnlFeePool' + 'A'.repeat(86) // unique stagenet placeholder

const created = { users: [], items: [], accounts: [], viewKeys: [], payIns: [], fees: [], subs: [] }
let rewardsWallet

// The observer attributes fee outputs by (major, minor), and the shared dev DB
// carries real pending payIns — one at the same minor starves these fixtures
// (2026-09-24: a user's ITEM_UPDATE payIns at major 1, minor 101/102 hijacked
// attribution). Take a random high base per run so fixtures never collide
// with real rows.
let nextSubMinor = 100_000 + Math.floor(Math.random() * 800_000)
const subMinor = () => nextSubMinor++

beforeAll(async () => {
  await sweepFakeRewardsWallets(['5Bare' + 'B'.repeat(91), '5Keyd' + 'C'.repeat(91), REWARDS_ADDR])
  rewardsWallet = await prisma.moneroAccount.create({
    data: { ownerUserId: null, address: REWARDS_ADDR, label: 'platform_rewards', network: 'STAGENET', status: 'ACTIVE' }
  })
  created.accounts.push(rewardsWallet.id)
})

afterEach(async () => {
  // FeeObservation rows are created by the indexer (linked to the seeded PayIns),
  // so clean them by payInId each test to keep the count-based assertions isolated.
  await prisma.feeObservation.deleteMany({ where: { payInId: { in: created.payIns } } })
})

afterAll(async () => {
  await prisma.feeObservation.deleteMany({ where: { payInId: { in: created.payIns } } })
  for (const name of created.subs) await prisma.sub.deleteMany({ where: { name } })
  await prisma.reply.deleteMany({ where: { itemId: { in: created.items } } })
  await prisma.reply.deleteMany({ where: { ancestorId: { in: created.items } } })
  for (const id of created.items) {
    await prisma.itemUserAgg.deleteMany({ where: { itemId: id } })
    await prisma.item.deleteMany({ where: { id } })
  }
  await prisma.payIn.deleteMany({ where: { id: { in: created.payIns } } })
  for (const id of created.viewKeys) await prisma.moneroViewKey.deleteMany({ where: { id } })
  for (const id of created.accounts) await prisma.moneroAccount.deleteMany({ where: { id } })
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } })
  await sweepFakeRewardsWallets(['5Bare' + 'B'.repeat(91), '5Keyd' + 'C'.repeat(91), REWARDS_ADDR])
  await prisma.$disconnect()
})

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(rows[0].id)
  return rows[0].id
}

// Seed an Item PENDING_FEE + its PayIn watching a rewards-wallet posting-fee
// subaddress (major 1, minor). Mirrors what itemCreate.onBegin produces
// (including the ItemPayIn link the indexer denormalizes onto the observation).
async function seedPendingFeePost (minor, moneroUri = null) {
  const userId = await createUser()
  const payIn = await prisma.payIn.create({
    data: {
      userId,
      payInType: 'ITEM_CREATE',
      payInState: 'PAID',
      piconeros: 0n,
      moneroUri,
      moneroSubaddressMajor: 1,
      moneroSubaddressMinor: minor
    }
  })
  created.payIns.push(payIn.id)
  const item = await prisma.item.create({
    data: { userId, title: 'pending-fee post', status: 'ACTIVE', feeStatus: 'PENDING_FEE', feePayInId: payIn.id }
  })
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(item.id)}::ltree WHERE id = ${item.id}::int`
  await prisma.itemPayIn.create({ data: { itemId: item.id, payInId: payIn.id } })
  created.items.push(item.id)
  return { item, payIn, major: 1, minor }
}

// Seed a PENDING_FEE COMMENT (reply) + its PayIn watching a rewards-wallet
// comment-fee subaddress (major 1, minor). Mirrors what itemCreate.onBegin
// produces for a reply beyond the monthly freebie quota.
async function seedPendingFeeComment (minor, moneroUri = null) {
  return await seedPendingFeeCommentFor(await createUser(), minor, moneroUri)
}

// The same seed for a caller-provided user: lets one user accumulate several
// pending-fee replies (the consecutive-flip credit-consumption test below).
async function seedPendingFeeCommentFor (userId, minor, moneroUri = null) {
  const root = await prisma.item.create({
    data: { userId, title: 'reply-thread root', status: 'ACTIVE' }
  })
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(root.id)}::ltree WHERE id = ${root.id}::int`
  const payIn = await prisma.payIn.create({
    data: {
      userId,
      payInType: 'ITEM_CREATE',
      payInState: 'PAID',
      piconeros: 0n,
      moneroUri,
      moneroSubaddressMajor: 1,
      moneroSubaddressMinor: minor
    }
  })
  created.payIns.push(payIn.id)
  const comment = await prisma.item.create({
    data: { userId, parentId: root.id, rootId: root.id, text: 'pending-fee reply', status: 'ACTIVE', feeStatus: 'PENDING_FEE', feePayInId: payIn.id }
  })
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(root.id) + '.' + String(comment.id)}::ltree WHERE id = ${comment.id}::int`
  await prisma.itemPayIn.create({ data: { itemId: comment.id, payInId: payIn.id } })
  created.items.push(root.id, comment.id)
  return { root, comment, payIn, major: 1, minor }
}

// Seed a Sub PENDING_FEE + its PayIn watching a rewards-wallet territory-fee
// subaddress (major 2, minor). Mirrors what territoryCreate.onBegin produces.
async function seedPendingFeeSub (minor) {
  const userId = await createUser()
  const subName = `turf-fee-${minor}`
  const payIn = await prisma.payIn.create({
    data: {
      userId,
      payInType: 'TERRITORY_BILLING',
      payInState: 'PAID',
      piconeros: 0n,
      moneroSubaddressMajor: 2,
      moneroSubaddressMinor: minor
    }
  })
  created.payIns.push(payIn.id)
  await prisma.sub.create({
    data: {
      name: subName,
      userId,
      rankingType: 'WOT',
      billingType: 'ONCE',
      billingCost: 1000000000,
      billingStatus: 'PENDING_FEE',
      billingPayInId: payIn.id
    }
  })
  created.subs.push(subName)
  await prisma.subPayIn.create({ data: { subName, payInId: payIn.id } })
  return { subName, payIn, major: 2, minor }
}

// seedPendingFeeSub with a monero: URI on the PayIn — the amount gate's input.
async function seedPendingFeeSubWithUri (minor, moneroUri = null) {
  const userId = await createUser()
  const subName = `turf-fee-${minor}`
  const payIn = await prisma.payIn.create({
    data: {
      userId,
      payInType: 'TERRITORY_BILLING',
      payInState: 'PAID',
      piconeros: 0n,
      moneroUri,
      moneroSubaddressMajor: 2,
      moneroSubaddressMinor: minor
    }
  })
  created.payIns.push(payIn.id)
  await prisma.sub.create({
    data: {
      name: subName,
      userId,
      rankingType: 'WOT',
      billingType: 'ONCE',
      billingCost: 1000000000,
      billingStatus: 'PENDING_FEE',
      billingPayInId: payIn.id
    }
  })
  created.subs.push(subName)
  await prisma.subPayIn.create({ data: { subName, payInId: payIn.id } })
  return { subName, payIn, major: 2, minor }
}

function lwsFeeTx (hash, piconeros, major, minor, height = 1234) {
  return { hash, piconeros: BigInt(piconeros), recipient: { maj_i: major, min_i: minor }, height, id: 1, payment_id: null }
}

// One banked REPLY credit row, unconsumed unless a test says otherwise.
async function seedReplyCredit (userId, { expiresInDays = 2, expiresDaysAgo = null } = {}) {
  if (expiresDaysAgo != null) {
    await prisma.$executeRaw`
      INSERT INTO "StreakReward" ("userId", "grantedAt", "expiresAt", "type")
      VALUES (${userId}::int, now_utc() - ${expiresDaysAgo + 1}::int * interval '1 day',
        now_utc() - ${expiresDaysAgo}::int * interval '1 day', 'REPLY'::"StreakRewardType")`
    return
  }
  await prisma.$executeRaw`
    INSERT INTO "StreakReward" ("userId", "grantedAt", "expiresAt", "type")
    VALUES (${userId}::int, now_utc(), now_utc() + ${expiresInDays}::int * interval '1 day', 'REPLY'::"StreakRewardType")`
}

test('rewardsWalletObserver attributes a posting fee by subaddress, creates FeeObservation DETECTED, flips Item FEE_PAID', async () => {
  const { item, payIn, major, minor } = await seedPendingFeePost(subMinor())
  await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsFeeTx('a1' + 'ab'.repeat(31), '1000000000', major, minor)] })

  const obs = await prisma.feeObservation.findFirst({ where: { payInId: payIn.id } })
  expect(obs).toBeTruthy()
  expect(obs.state).toBe('DETECTED')
  expect(obs.piconeros).toBe(1_000_000_000n)
  expect(obs.feeType).toBe('POSTING')
  // the ItemPayIn link is denormalized so analytics/history can find the post
  expect(obs.postId).toBe(item.id)
  expect(obs.subName).toBeNull()

  const live = await prisma.item.findUnique({ where: { id: item.id } })
  expect(live.feeStatus).toBe('FEE_PAID')
  expect(live.feeInvestmentPiconeros).toBe(1_000_000_000n)
  expect(live.netInvestment).toBe(1_000_000_000n) // trigger folds the fee in
})

test('rewardsWalletObserver attributes a territory fee by subaddress, denormalizing the Sub name', async () => {
  const { subName, payIn, major, minor } = await seedPendingFeeSub(subMinor())
  await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsFeeTx('e5' + '56'.repeat(31), '200000000000', major, minor)] })

  const obs = await prisma.feeObservation.findFirst({ where: { payInId: payIn.id } })
  expect(obs).toBeTruthy()
  expect(obs.state).toBe('DETECTED')
  expect(obs.piconeros).toBe(200_000_000_000n)
  expect(obs.feeType).toBe('TERRITORY_BILLING')
  // the SubPayIn link is denormalized so analytics/history can find the turf
  expect(obs.postId).toBeNull()
  expect(obs.subName).toBe(subName)

  const live = await prisma.sub.findUnique({ where: { name: subName } })
  expect(live.billingStatus).toBe('PAID')
})

test('rewardsWalletObserver is idempotent across re-polls', async () => {
  const { item, payIn, major, minor } = await seedPendingFeePost(subMinor())
  const tx = lwsFeeTx('b2' + 'cd'.repeat(31), '1000000000', major, minor)
  await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [tx] })
  await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [tx] })
  const count = await prisma.feeObservation.count({ where: { payInId: payIn.id } })
  expect(count).toBe(1)
  const live = await prisma.item.findUnique({ where: { id: item.id } })
  expect(live.feeStatus).toBe('FEE_PAID')
  expect(live.feeInvestmentPiconeros).toBe(1_000_000_000n)
  expect(live.netInvestment).toBe(1_000_000_000n)
})

test('rewardsWalletObserver ignores outputs whose subaddress matches no pending fee (Phase 4 downvote path)', async () => {
  // major 0 / minor 0 with a payment_id -> not a fee subaddress; no FeeObservation, no throw
  const tx = lwsFeeTx('c3' + 'ef'.repeat(31), '1000000000', 0, 0)
  tx.payment_id = 'aabbccddeeff0011'
  const before = await prisma.feeObservation.count()
  await expect(runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [tx] })).resolves.toBeUndefined()
  expect(await prisma.feeObservation.count()).toBe(before)
})

test('rewardsWalletObserver ignores a fee subaddress with no pending PayIn (already consumed / unknown)', async () => {
  // major 1, a fresh minor has no PayIn reserved -> skip silently
  const tx = lwsFeeTx('d4' + '12'.repeat(31), '1000000000', 1, subMinor())
  const before = await prisma.feeObservation.count()
  await expect(runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [tx] })).resolves.toBeUndefined()
  expect(await prisma.feeObservation.count()).toBe(before)
})

// Seed an Item + BOOST PayIn watching a rewards-wallet boost subaddress
// (major 5, minor). Mirrors what boost.getInitial produces (including the
// ItemPayIn link the indexer denormalizes onto the observation).
async function seedBoostPayIn (minor) {
  const userId = await createUser()
  const payIn = await prisma.payIn.create({
    data: {
      userId,
      payInType: 'BOOST',
      payInState: 'PAID',
      piconeros: 0n,
      moneroSubaddressMajor: 5,
      moneroSubaddressMinor: minor
    }
  })
  created.payIns.push(payIn.id)
  const item = await prisma.item.create({
    data: { userId, title: 'boosted post', status: 'ACTIVE' }
  })
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(item.id)}::ltree WHERE id = ${item.id}::int`
  await prisma.itemPayIn.create({ data: { itemId: item.id, payInId: payIn.id } })
  created.items.push(item.id)
  return { payInId: payIn.id, postId: item.id, major: 5, minor }
}

test('a BOOST fee observation bumps Item.boost at DETECTION', async () => {
  const { payInId, postId, major, minor } = await seedBoostPayIn(subMinor())
  const before = await prisma.item.findUnique({ where: { id: postId }, select: { boost: true } })

  const tx = {
    hash: 'boost-tx-' + Date.now(),
    piconeros: 1_000_000_000n,
    height: 100,
    recipient: { maj_i: major, min_i: minor },
    payment_id: null
  }
  await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [tx] })

  const after = await prisma.item.findUnique({ where: { id: postId }, select: { boost: true } })
  expect(Number(after.boost) - Number(before.boost)).toBe(1_000_000_000)

  const fee = await prisma.feeObservation.findFirst({ where: { payInId } })
  expect(fee.feeType).toBe('BOOST')
  expect(fee.piconeros).toBe(1_000_000_000n)
})

// A-14 follow-up (Task 6): boosts above Int4 max (2,147,483,647 piconeros ~
// 0.0021 XMR) must not silently fail. The old `boost + ${piconeros}::INTEGER`
// cast threw "integer out of range" (caught by the try/catch), so the payment
// succeeded but the ranking bump never happened. With the columns now BigInt
// and the casts ::BIGINT, 1 XMR = 1e12 piconeros bumps boost 1:1.
test('a BOOST fee observation above Int4 max (1 XMR) bumps Item.boost at DETECTION', async () => {
  const { payInId, postId, major, minor } = await seedBoostPayIn(subMinor())
  const before = await prisma.item.findUnique({ where: { id: postId }, select: { boost: true } })

  const tx = {
    hash: 'boost-bigint-tx-' + Date.now(),
    piconeros: 1_000_000_000_000n,
    height: 100,
    recipient: { maj_i: major, min_i: minor },
    payment_id: null
  }
  await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [tx] })

  const after = await prisma.item.findUnique({ where: { id: postId }, select: { boost: true } })
  expect(Number(after.boost) - Number(before.boost)).toBe(1_000_000_000_000)

  const fee = await prisma.feeObservation.findFirst({ where: { payInId } })
  expect(fee.feeType).toBe('BOOST')
  expect(fee.piconeros).toBe(1_000_000_000_000n)
})

// A-13 regression guard (2026-08-10 live incident): the observer's pg-boss
// handler selects the platform_rewards account with a bare findFirst. Test
// suites (boost payIn, observer suites themselves) seed viewKey-less
// platform_rewards rows against the live DB; with no orderBy/filter the
// handler can pick one, viewKeyFor throws, the job dies (failed, retrylimit 0)
// and ALL fee attribution stops until a worker restart (observed live: item
// 2755 stuck PENDING_FEE). The handler must deterministically select a
// viewKey'd account. This test pins the query contract via the exported
// helper.
test('findRewardsAccount selects a viewKey-bearing platform_rewards account deterministically', async () => {
  // viewKey-less platform_rewards row (autoincrement id)
  const bare = await prisma.moneroAccount.create({
    data: { ownerUserId: null, address: '5Bare' + 'B'.repeat(91), label: 'platform_rewards', network: 'STAGENET', status: 'ACTIVE' }
  })
  created.accounts.push(bare.id)
  // viewKey-bearing platform_rewards row
  const keyed = await prisma.moneroAccount.create({
    data: { ownerUserId: null, address: '5Keyd' + 'C'.repeat(91), label: 'platform_rewards', network: 'STAGENET', status: 'ACTIVE' }
  })
  created.accounts.push(keyed.id)
  const vk = await prisma.moneroViewKey.create({
    data: {
      accountId: keyed.id,
      ciphertext: Buffer.from('a'.repeat(32)),
      iv: Buffer.from('a'.repeat(12)),
      tag: Buffer.from('a'.repeat(16)),
      wrappedDek: Buffer.from('a'.repeat(32)),
      dekVersion: 1
    }
  })
  created.viewKeys.push(vk.id)
  created.accounts.push(keyed.id)

  const account = await findRewardsAccount(prisma)

  expect(account).not.toBeNull()
  expect(account.address).not.toBe(bare.address)
  expect(account.viewKey).not.toBeNull()
})

test('a DONATE payIn with donationRewardsPct copies the split onto the FeeObservation', async () => {
  const userId = await createUser()
  const donateMinor = subMinor()
  const payIn = await prisma.payIn.create({
    data: {
      userId,
      payInType: 'DONATE',
      payInState: 'PAID',
      piconeros: 0n,
      moneroSubaddressMajor: 3,
      moneroSubaddressMinor: donateMinor,
      donationRewardsPct: 40
    }
  })
  created.payIns.push(payIn.id)
  await runRewardsWalletObserverOnce({
    models: prisma,
    account: rewardsWallet,
    txs: [lwsFeeTx('donate-split-tx-' + Date.now(), '2000000000', 3, donateMinor)]
  })
  const obs = await prisma.feeObservation.findFirst({ where: { payInId: payIn.id } })
  expect(obs.feeType).toBe('DONATE')
  expect(obs.donationRewardsPct).toBe(40)
  expect(obs.piconeros).toBe(2_000_000_000n)
})

// A 0.001 XMR expected posting fee paid 40% up front: the FeeObservation is
// recorded but the Item must STAY PENDING_FEE until the cumulative received
// covers the URI's tx_amount.
const FEE_URI = (xmr) => `monero:5${'F'.repeat(94)}?tx_amount=${xmr}`

test('an underpaid posting fee records its FeeObservation but does NOT flip the item live', async () => {
  const { item, payIn, major, minor } = await seedPendingFeePost(subMinor(), FEE_URI('0.001'))
  await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsFeeTx('f1' + 'ab'.repeat(31), '400000000', major, minor)] })

  const obs = await prisma.feeObservation.findFirst({ where: { payInId: payIn.id } })
  expect(obs).toBeTruthy()
  expect(obs.state).toBe('DETECTED')
  expect(obs.piconeros).toBe(400_000_000n)

  const stillPending = await prisma.item.findUnique({ where: { id: item.id } })
  expect(stillPending.feeStatus).toBe('PENDING_FEE')
  expect(stillPending.feeInvestmentPiconeros).toBe(0n)
})

test('a top-up to the same subaddress accumulates and flips the item live at the full fee', async () => {
  const { item, payIn, major, minor } = await seedPendingFeePost(subMinor(), FEE_URI('0.001'))
  await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsFeeTx('f2' + 'ab'.repeat(31), '400000000', major, minor)] })
  await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsFeeTx('f3' + 'ab'.repeat(31), '600000000', major, minor)] })

  // TWO observation rows for one payIn — possible only after Task 2's unique drop
  const rows = await prisma.feeObservation.findMany({ where: { payInId: payIn.id } })
  expect(rows).toHaveLength(2)

  const live = await prisma.item.findUnique({ where: { id: item.id } })
  expect(live.feeStatus).toBe('FEE_PAID')
  expect(live.feeInvestmentPiconeros).toBe(1_000_000_000n)
  expect(live.netInvestment).toBe(1_000_000_000n)
})

test('a fee-paid reply denormalizes its ancestors + Reply rows exactly once at the flip', async () => {
  const { root, comment, major, minor } = await seedPendingFeeComment(subMinor(), FEE_URI('0.001'))
  const tx = lwsFeeTx('r1' + 'ab'.repeat(31), '1000000000', major, minor)
  await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [tx] })

  const live = await prisma.item.findUnique({ where: { id: comment.id } })
  expect(live.feeStatus).toBe('FEE_PAID')

  const rootAfter = await prisma.item.findUnique({ where: { id: root.id } })
  expect(rootAfter.ncomments).toBe(1)
  expect(rootAfter.nDirectComments).toBe(1)
  const replies = await prisma.$queryRaw`SELECT * FROM "Reply" WHERE "itemId" = ${comment.id}::int`
  expect(replies).toHaveLength(1)
  expect(replies[0].ancestorId).toBe(root.id)

  // re-poll of the same tx: the FeeObservation insert conflicts, but the
  // amount gate + flip re-run idempotently — the WHERE "feeStatus" =
  // 'PENDING_FEE' guard updates 0 rows, so no double denormalization
  await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [tx] })
  const rootAgain = await prisma.item.findUnique({ where: { id: root.id } })
  expect(rootAgain.ncomments).toBe(1)
})

test('an over-payment top-up after the flip does not double-denormalize', async () => {
  const { root, major, minor } = await seedPendingFeeComment(subMinor(), FEE_URI('0.001'))
  await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsFeeTx('r3' + 'ab'.repeat(31), '1000000000', major, minor)] })
  await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsFeeTx('r4' + 'ab'.repeat(31), '500000000', major, minor)] })
  const rootAfter = await prisma.item.findUnique({ where: { id: root.id } })
  expect(rootAfter.ncomments).toBe(1)
})

test('an underpaid reply stays PENDING_FEE and does not denormalize', async () => {
  const { root, major, minor } = await seedPendingFeeComment(subMinor(), FEE_URI('0.001'))
  await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsFeeTx('r2' + 'ab'.repeat(31), '400000000', major, minor)] })
  const rootAfter = await prisma.item.findUnique({ where: { id: root.id } })
  expect(rootAfter.ncomments).toBe(0)
  expect(rootAfter.nDirectComments).toBe(0)
})

test('a single full payment still flips immediately (no behavior change for honest payers)', async () => {
  const { item, major, minor } = await seedPendingFeePost(subMinor(), FEE_URI('0.001'))
  await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsFeeTx('f4' + 'ab'.repeat(31), '1000000000', major, minor)] })
  const live = await prisma.item.findUnique({ where: { id: item.id } })
  expect(live.feeStatus).toBe('FEE_PAID')
})

// Stranded-flip regression guard: a re-poll whose FeeObservation INSERT conflicts
// (the observation row committed on a prior poll, but flipPendingToLive's
// transaction failed/rolled back, leaving the item PENDING_FEE) must still flip
// the item — NOT short-circuit on the empty conflict rows.
test('a re-poll of an already-observed tx self-heals a stranded PENDING_FEE flip', async () => {
  const { item, payIn, major, minor } = await seedPendingFeePost(subMinor(), FEE_URI('0.001'))
  const txHash = 'selfheal-' + Date.now() + '-' + item.id

  // Simulate the stranded state: the observation row committed on a prior poll
  // (autocommit INSERT) but the flip transaction failed afterwards. Mirror the
  // columns/values the observer writes in attributeFeeBySubaddress.
  await prisma.feeObservation.create({
    data: {
      txHash,
      payInId: payIn.id,
      feeType: 'POSTING',
      postId: item.id,
      recipientMajor: major,
      recipientMinor: minor,
      piconeros: 1_000_000_000n,
      height: 1234,
      state: 'DETECTED'
    }
  })

  // Re-poll of the SAME tx: ON CONFLICT DO NOTHING inserts nothing, but the
  // stranded item must still flip live (self-healing, not short-circuited).
  await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsFeeTx(txHash, '1000000000', major, minor)] })

  const live = await prisma.item.findUnique({ where: { id: item.id } })
  expect(live.feeStatus).toBe('FEE_PAID')
  expect(live.feeInvestmentPiconeros).toBe(1_000_000_000n)
  expect(live.netInvestment).toBe(1_000_000_000n)

  // the conflict inserted no duplicate observation row
  const count = await prisma.feeObservation.count({ where: { payInId: payIn.id } })
  expect(count).toBe(1)
})

test('an underpaid TERRITORY fee does not flip billingStatus to PAID', async () => {
  const { subName, major, minor } = await seedPendingFeeSubWithUri(subMinor(), FEE_URI('1'))
  await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsFeeTx('f5' + 'ab'.repeat(31), '500000000000', major, minor)] })
  const sub = await prisma.sub.findUnique({ where: { name: subName } })
  expect(sub.billingStatus).toBe('PENDING_FEE')
})

// --- R01: feeQuotaEligible items consume their free quota at the flip ---

test('a feeQuotaEligible COMMENT consumes its free-comment quota when it flips live (R01)', async () => {
  const { comment, major, minor } = await seedPendingFeeComment(subMinor())
  await prisma.item.update({ where: { id: comment.id }, data: { feeQuotaEligible: true } })
  await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsFeeTx('a7' + '89'.repeat(31), '1000000000', major, minor)] })
  const live = await prisma.item.findUnique({ where: { id: comment.id } })
  expect(live.feeStatus).toBe('FEE_PAID')
  const user = await prisma.user.findUnique({ where: { id: comment.userId } })
  expect(user.freeCommentCount).toBe(1)
  expect(user.freeCommentResetAt).toBeTruthy()
})

test('a feeQuotaEligible POST consumes its free-post quota when it flips live (R01)', async () => {
  const { item, major, minor } = await seedPendingFeePost(subMinor())
  await prisma.item.update({ where: { id: item.id }, data: { feeQuotaEligible: true } })
  await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsFeeTx('b8' + '9a'.repeat(31), '1000000000', major, minor)] })
  const live = await prisma.item.findUnique({ where: { id: item.id } })
  expect(live.feeStatus).toBe('FEE_PAID')
  const user = await prisma.user.findUnique({ where: { id: item.userId } })
  expect(user.freePostCount).toBe(1)
  expect(user.freePostResetAt).toBeTruthy()
})

test('an UNMARKED pending-fee item consumes no quota on flip (over-quota / anon / bio paths)', async () => {
  const { comment, major, minor } = await seedPendingFeeComment(subMinor())
  await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsFeeTx('c9' + 'ab'.repeat(31), '1000000000', major, minor)] })
  const live = await prisma.item.findUnique({ where: { id: comment.id } })
  expect(live.feeStatus).toBe('FEE_PAID')
  const user = await prisma.user.findUnique({ where: { id: comment.userId } })
  expect(user.freeCommentCount).toBe(0) // never touched
  expect(user.freeCommentResetAt).toBeNull() // never touched
})

test('quota consumption is exactly-once across re-polls (R01)', async () => {
  const { comment, major, minor } = await seedPendingFeeComment(subMinor())
  await prisma.item.update({ where: { id: comment.id }, data: { feeQuotaEligible: true } })
  const tx = lwsFeeTx('da' + 'bc'.repeat(31), '1000000000', major, minor)
  await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [tx] })
  await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [tx] })
  const user = await prisma.user.findUnique({ where: { id: comment.userId } })
  expect(user.freeCommentCount).toBe(1)
})

// --- finding 6: the flip-time comment spend is base-first, credit-aware and
// serialized. Before the fix the comment branch force-incremented an already
// exhausted base counter and never touched a banked REPLY credit, so the
// credit-aware creation gate (commentQuotaFor) could waive the reply fee on
// upload-fee replies indefinitely without ever spending the credit. ---

async function consumedReplyCredits (userId) {
  return await prisma.streakReward.count({ where: { userId, type: 'REPLY', consumedAt: { not: null } } })
}

test('a feeQuotaEligible COMMENT flip spends the live weekly base first and leaves a banked REPLY credit untouched', async () => {
  const { comment, major, minor } = await seedPendingFeeComment(subMinor())
  await prisma.item.update({ where: { id: comment.id }, data: { feeQuotaEligible: true } })
  await prisma.$executeRaw`UPDATE users SET "freeCommentCount" = 0, "freeCommentResetAt" = now() + interval '3 days' WHERE id = ${comment.userId}::int`
  await seedReplyCredit(comment.userId)

  await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsFeeTx('f6' + '01'.repeat(31), '1000000000', major, minor)] })

  const user = await prisma.user.findUnique({ where: { id: comment.userId } })
  expect(user.freeCommentCount).toBe(1)
  expect(await consumedReplyCredits(comment.userId)).toBe(0)
})

test('a stale weekly window re-baselines at the flip and still preserves the held REPLY credit', async () => {
  const { comment, major, minor } = await seedPendingFeeComment(subMinor())
  await prisma.item.update({ where: { id: comment.id }, data: { feeQuotaEligible: true } })
  await prisma.$executeRaw`UPDATE users SET "freeCommentCount" = 3, "freeCommentResetAt" = now() - interval '1 day' WHERE id = ${comment.userId}::int`
  await seedReplyCredit(comment.userId)

  await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsFeeTx('f6' + '02'.repeat(31), '1000000000', major, minor)] })

  const user = await prisma.user.findUnique({ where: { id: comment.userId } })
  expect(user.freeCommentCount).toBe(1) // never accumulates
  expect(new Date(user.freeCommentResetAt).getTime()).toBeGreaterThan(Date.now())
  expect(await consumedReplyCredits(comment.userId)).toBe(0)
})

test('a base-exhausted COMMENT flip consumes exactly one banked REPLY credit, soonest-expiring first, and leaves the over-quota counter alone', async () => {
  const { comment, major, minor } = await seedPendingFeeComment(subMinor())
  await prisma.item.update({ where: { id: comment.id }, data: { feeQuotaEligible: true } })
  await prisma.$executeRaw`UPDATE users SET "freeCommentCount" = 1, "freeCommentResetAt" = now() + interval '1 day' WHERE id = ${comment.userId}::int`
  await seedReplyCredit(comment.userId, { expiresInDays: 2 })
  await seedReplyCredit(comment.userId, { expiresInDays: 20 })

  await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsFeeTx('f6' + '03'.repeat(31), '1000000000', major, minor)] })

  const user = await prisma.user.findUnique({ where: { id: comment.userId } })
  expect(user.freeCommentCount).toBe(1) // the exhausted base is not incremented
  expect(await consumedReplyCredits(comment.userId)).toBe(1)
  const [consumed] = await prisma.$queryRaw`
    SELECT "expiresAt" FROM "StreakReward"
    WHERE "userId" = ${comment.userId}::int AND type = 'REPLY' AND "consumedAt" IS NOT NULL`
  // the 2-day credit went first, not the 20-day one
  expect(new Date(consumed.expiresAt).getTime() - Date.now()).toBeLessThan(5 * 86_400_000)
})

test('consecutive base-exhausted flips drain credits one at a time; the exhausted flip is surfaced WITHOUT blocking publication', async () => {
  const userId = await createUser()
  const first = await seedPendingFeeCommentFor(userId, subMinor())
  const second = await seedPendingFeeCommentFor(userId, subMinor())
  const third = await seedPendingFeeCommentFor(userId, subMinor())
  for (const s of [first, second, third]) {
    await prisma.item.update({ where: { id: s.comment.id }, data: { feeQuotaEligible: true } })
  }
  await prisma.$executeRaw`UPDATE users SET "freeCommentCount" = 1, "freeCommentResetAt" = now() + interval '1 day' WHERE id = ${userId}::int`
  await seedReplyCredit(userId, { expiresInDays: 2 })
  await seedReplyCredit(userId, { expiresInDays: 20 })

  alert.mockClear()
  logError.mockClear()
  await runRewardsWalletObserverOnce({
    models: prisma,
    account: rewardsWallet,
    txs: [
      lwsFeeTx('f6' + '04'.repeat(31), '1000000000', first.major, first.minor),
      lwsFeeTx('f6' + '05'.repeat(31), '1000000000', second.major, second.minor),
      lwsFeeTx('f6' + '06'.repeat(31), '1000000000', third.major, third.minor)
    ]
  })

  // every paid item went live — bookkeeping can never gate publication
  for (const s of [first, second, third]) {
    const live = await prisma.item.findUnique({ where: { id: s.comment.id } })
    expect(live.feeStatus).toBe('FEE_PAID')
  }
  expect(await consumedReplyCredits(userId)).toBe(2)
  const user = await prisma.user.findUnique({ where: { id: userId } })
  expect(user.freeCommentCount).toBe(1)

  // the third flip's missing credit is surfaced through the existing guard
  const logged = logError.mock.calls.find(c => c[0] === 'flipPendingToLive: quota consumption failed')
  expect(logged).toBeTruthy()
  expect(String(logged[1]?.message)).toContain('no free comments left')
  expect(alert).toHaveBeenCalledWith(
    'critical',
    expect.any(String),
    expect.stringContaining(`payIn ${third.payIn.id}`),
    { dedupeKey: `flip-quota-${third.payIn.id}` })
})

test('an EXPIRED banked REPLY credit cannot underwrite the flip: the paid item goes live and the missing credit is surfaced', async () => {
  const { comment, payIn, major, minor } = await seedPendingFeeComment(subMinor())
  await prisma.item.update({ where: { id: comment.id }, data: { feeQuotaEligible: true } })
  await prisma.$executeRaw`UPDATE users SET "freeCommentCount" = 1, "freeCommentResetAt" = now() + interval '1 day' WHERE id = ${comment.userId}::int`
  await seedReplyCredit(comment.userId, { expiresDaysAgo: 1 })

  alert.mockClear()
  logError.mockClear()
  await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsFeeTx('f6' + '07'.repeat(31), '1000000000', major, minor)] })

  const live = await prisma.item.findUnique({ where: { id: comment.id } })
  expect(live.feeStatus).toBe('FEE_PAID')
  expect(await consumedReplyCredits(comment.userId)).toBe(0)
  const user = await prisma.user.findUnique({ where: { id: comment.userId } })
  expect(user.freeCommentCount).toBe(1)
  const logged = logError.mock.calls.find(c => c[0] === 'flipPendingToLive: quota consumption failed')
  expect(logged).toBeTruthy()
  expect(String(logged[1]?.message)).toContain('no free comments left')
  expect(alert).toHaveBeenCalledWith(
    'critical',
    expect.any(String),
    expect.stringContaining(`payIn ${payIn.id}`),
    { dedupeKey: `flip-quota-${payIn.id}` })
})
