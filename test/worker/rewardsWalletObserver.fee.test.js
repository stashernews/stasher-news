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
import { runRewardsWalletObserverOnce } from '@/worker/rewardsWalletObserver'

const prisma = new PrismaClient()

const REWARDS_ADDR = '5RpnlFeePool' + 'A'.repeat(86) // unique stagenet placeholder

const created = { users: [], items: [], accounts: [], payIns: [], fees: [], subs: [] }
let rewardsWallet

beforeAll(async () => {
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
  for (const id of created.accounts) await prisma.moneroAccount.deleteMany({ where: { id } })
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } })
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
async function seedPendingFeePost (minor) {
  const userId = await createUser()
  const payIn = await prisma.payIn.create({
    data: {
      userId,
      payInType: 'ITEM_CREATE',
      payInState: 'PAID',
      piconeros: 0n,
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
