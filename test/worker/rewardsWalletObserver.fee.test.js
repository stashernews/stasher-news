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
import { sweepFakeRewardsWallets } from '../helpers/sweepRewardsWallets'

const prisma = new PrismaClient()

const REWARDS_ADDR = '5RpnlFeePool' + 'A'.repeat(86) // unique stagenet placeholder

const created = { users: [], items: [], accounts: [], viewKeys: [], payIns: [], fees: [], subs: [] }
let rewardsWallet

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

test('rewardsWalletObserver attributes a posting fee by subaddress, creates FeeObservation DETECTED, flips Item FEE_PAID', async () => {
  const { item, payIn, major, minor } = await seedPendingFeePost(101)
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
  const { subName, payIn, major, minor } = await seedPendingFeeSub(201)
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
  const { item, payIn, major, minor } = await seedPendingFeePost(102)
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
  // major 1, minor 999 has no PayIn reserved -> skip silently
  const tx = lwsFeeTx('d4' + '12'.repeat(31), '1000000000', 1, 999)
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
  const { payInId, postId, major, minor } = await seedBoostPayIn(301)
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
  const { payInId, postId, major, minor } = await seedBoostPayIn(302)
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
  const payIn = await prisma.payIn.create({
    data: {
      userId,
      payInType: 'DONATE',
      payInState: 'PAID',
      piconeros: 0n,
      moneroSubaddressMajor: 3,
      moneroSubaddressMinor: 99,
      donationRewardsPct: 40
    }
  })
  created.payIns.push(payIn.id)
  await runRewardsWalletObserverOnce({
    models: prisma,
    account: rewardsWallet,
    txs: [lwsFeeTx('donate-split-tx-' + Date.now(), '2000000000', 3, 99)]
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
  const { item, payIn, major, minor } = await seedPendingFeePost(111, FEE_URI('0.001'))
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
  const { item, payIn, major, minor } = await seedPendingFeePost(112, FEE_URI('0.001'))
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

test('a single full payment still flips immediately (no behavior change for honest payers)', async () => {
  const { item, major, minor } = await seedPendingFeePost(113, FEE_URI('0.001'))
  await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsFeeTx('f4' + 'ab'.repeat(31), '1000000000', major, minor)] })
  const live = await prisma.item.findUnique({ where: { id: item.id } })
  expect(live.feeStatus).toBe('FEE_PAID')
})

test('an underpaid TERRITORY fee does not flip billingStatus to PAID', async () => {
  const { subName, major, minor } = await seedPendingFeeSubWithUri(202, FEE_URI('1'))
  await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsFeeTx('f5' + 'ab'.repeat(31), '500000000000', major, minor)] })
  const sub = await prisma.sub.findUnique({ where: { name: subName } })
  expect(sub.billingStatus).toBe('PENDING_FEE')
})
