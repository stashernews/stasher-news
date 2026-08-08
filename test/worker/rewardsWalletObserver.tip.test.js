/* eslint-env jest */

// Integration test for the rewardsWalletObserver tip-attribution branch.
//
// A wallet-less-author tip is paid to the rewards wallet PRIMARY address (major
// 0) carrying a "tip:"-namespace payment_id. The observer's dispatcher runs the
// downvote reverse-map first (misses — different namespace), then this branch:
// it looks the payment_id up on ObservedTip and, if found, idempotently records
// a FeeObservation(TIP_UNWALLETED, payInId=null) ledger row. confirmFinalizer
// matures it; rewardsDistributor/rewards count it at walletlessTipRewardsPct.

import { PrismaClient } from '@prisma/client'
import { runRewardsWalletObserverOnce } from '@/worker/rewardsWalletObserver'
import { generateTipPaymentId } from '@/api/monero/paymentId'

const prisma = new PrismaClient()

const REWARDS_ADDR = '5RpnlTipObs' + 'C'.repeat(86) // unique stagenet placeholder

const created = { users: [], items: [], accounts: [], tips: [], fees: [] }
let rewardsWallet

beforeAll(async () => {
  rewardsWallet = await prisma.moneroAccount.create({
    data: { ownerUserId: null, address: REWARDS_ADDR, label: 'platform_rewards', network: 'STAGENET', status: 'ACTIVE' }
  })
  created.accounts.push(rewardsWallet.id)
})

afterAll(async () => {
  for (const id of created.fees) await prisma.feeObservation.deleteMany({ where: { id } })
  for (const id of created.tips) await prisma.observedTip.deleteMany({ where: { id } })
  for (const id of created.items) await prisma.item.deleteMany({ where: { id } })
  for (const id of created.accounts) await prisma.moneroAccount.deleteMany({ where: { id } })
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } })
  await prisma.$disconnect()
})

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(rows[0].id)
  return rows[0].id
}

async function createPost (userId) {
  const item = await prisma.item.create({ data: { userId, title: 'anon tip target', status: 'ACTIVE' } })
  created.items.push(item.id)
  return item
}

async function seedPendingTip (postId, tipperId, piconeros) {
  const nonce = Date.now()
  const paymentId = generateTipPaymentId(postId, nonce)
  const tip = await prisma.observedTip.create({
    data: {
      txHash: 'pending-' + paymentId,
      postId,
      tipperId,
      recipientAccountId: rewardsWallet.id,
      paymentId,
      piconeros,
      state: 'PENDING',
      proofType: 'INDEXED'
    }
  })
  created.tips.push(tip.id)
  return { tip, paymentId }
}

function lwsTipTx (hash, paymentId, piconeros, height = 1000) {
  return { hash, piconeros: BigInt(piconeros), recipient: { maj_i: 0, min_i: 0 }, height, id: 1, payment_id: paymentId }
}

test('rewardsWalletObserver attributes a tip payment_id to a FeeObservation(TIP_UNWALLETED) with null payInId', async () => {
  const tipperId = await createUser()
  const post = await createPost(tipperId)
  const PICONEROS = 1_000_000_000n
  const { paymentId } = await seedPendingTip(post.id, tipperId, PICONEROS)

  await runRewardsWalletObserverOnce({
    models: prisma,
    account: rewardsWallet,
    txs: [lwsTipTx('7a' + 'bc'.repeat(31), paymentId, PICONEROS)]
  })

  const fee = await prisma.feeObservation.findFirst({ where: { txHash: '7a' + 'bc'.repeat(31) } })
  expect(fee).toBeTruthy()
  expect(fee.feeType).toBe('TIP_UNWALLETED')
  expect(fee.payInId).toBeNull()
  expect(fee.postId).toBe(post.id)
  expect(fee.recipientMajor).toBe(0)
  expect(fee.recipientMinor).toBe(0)
  expect(fee.piconeros).toBe(PICONEROS)
  expect(fee.state).toBe('DETECTED')
  created.fees.push(fee.id)
})

test('rewardsWalletObserver is idempotent across re-polls (no duplicate FeeObservation)', async () => {
  const tipperId = await createUser()
  const post = await createPost(tipperId)
  const PICONEROS = 2_000_000_000n
  const { paymentId } = await seedPendingTip(post.id, tipperId, PICONEROS)
  const tx = lwsTipTx('8b' + 'de'.repeat(31), paymentId, PICONEROS)

  await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [tx] })
  await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [tx] })

  const count = await prisma.feeObservation.count({ where: { txHash: '8b' + 'de'.repeat(31) } })
  expect(count).toBe(1)
  const fee = await prisma.feeObservation.findFirst({ where: { txHash: '8b' + 'de'.repeat(31) } })
  created.fees.push(fee.id)
})

test('rewardsWalletObserver ignores a payment_id with no matching ObservedTip (stray)', async () => {
  await expect(
    runRewardsWalletObserverOnce({
      models: prisma,
      account: rewardsWallet,
      txs: [lwsTipTx('9c' + 'f0'.repeat(31), 'ffffffffffffffff', 1_000_000_000n)]
    })
  ).resolves.toBeUndefined()
  expect(await prisma.feeObservation.count({ where: { txHash: '9c' + 'f0'.repeat(31) } })).toBe(0)
})
