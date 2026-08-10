/* eslint-env jest */

// Integration test for the bounties lifecycle worker (A-13 Phase B):
//   1. EXPIRY: FUNDED bounties past bountyExpiryDays (from bountyConfirmedAt)
//      flip to EXPIRED (author can then reclaim or roll over).
//   2. SEND: QUEUED BountyPayments are dispatched by the escrow signer
//      (relay-before-persist; the signer records txHash + best-effort height).
//   3. MATURITY: SENT payouts with a recorded height flip to CONFIRMED at
//      REQUIRED_CONFIRMATIONS (daemon height fetched once per run).
//
// runBountiesOnce is the testable core of the pg-boss bounties job — same
// pattern as runConfirmFinalizerOnce (worker/confirmFinalizer.js). The only
// DI seams are the network boundaries: sendBountyPayments (signer) and
// getHeight (daemon). Everything else runs against a live, migrated dev DB,
// mirroring test/worker/confirmFinalizer.test.js and test/api/bountyLifecycle.test.js.
//
// The sendBountyPayments stub only touches rows this suite seeded — a stray
// QUEUED row left by an interrupted sibling suite must never be flipped by
// the stub (the real worker would have sent it, but the stub is not the signer).

import { PrismaClient } from '@prisma/client'
import { runBountiesOnce } from '@/worker/bounties'

const prisma = new PrismaClient()

const ADDR = '5' + '3'.repeat(94) // 95-char Monero address placeholder

// Tracks every row created across tests so afterAll can tear them down in
// FK-safe order: BountyPayment -> Item -> users.
const created = { users: [], items: [], payments: [] }

afterAll(async () => {
  await prisma.bountyPayment.deleteMany({ where: { id: { in: created.payments } } })
  for (const id of created.items) {
    await prisma.itemUserAgg.deleteMany({ where: { itemId: id } })
    await prisma.item.deleteMany({ where: { id } })
  }
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } })
  await prisma.$disconnect()
})

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  const id = rows[0].id
  created.users.push(id)
  return id
}

// A bounty root post, directly seeded (bypassing the funding flow) so the test
// exercises ONLY the worker's expiry/send/maturity paths.
let itemSeq = 0
async function createBountyPost (userId, { confirmedAt = new Date() } = {}) {
  itemSeq += 1
  const item = await prisma.item.create({
    data: {
      userId,
      title: 'bounties worker fixture ' + itemSeq,
      status: 'ACTIVE',
      bountyPiconeros: 5_000_000_000n,
      bountyStatus: 'FUNDED',
      bountyConfirmedAt: confirmedAt
    }
  })
  created.items.push(item.id)
  return item
}

// A BountyPayment directly seeded (bypassing payBounty) so the test exercises
// ONLY the worker's SEND/MATURITY flips. txHash below derives from the unique
// payout id, so rows are always distinct.
async function seedPayout (itemId, winnerUserId, { state, height } = {}) {
  const payout = await prisma.bountyPayment.create({
    data: {
      itemId,
      winnerUserId,
      piconeros: 5_000_000_000n,
      feePiconeros: 0n,
      recipientAddress: ADDR,
      kind: 'AWARD',
      state,
      height
    }
  })
  created.payments.push(payout.id)
  return payout
}

// Stub signer: mirrors sendBountyPayments' SENT update (txHash + best-effort
// height 205, i.e. 4 confs below the mocked chain 209, so a freshly sent
// payout stays SENT in the same run instead of racing to CONFIRMED).
function makeSendStub () {
  return jest.fn(async (payouts, { models }) => {
    for (const payout of payouts) {
      if (!created.payments.includes(payout.id)) continue
      await models.bountyPayment.update({
        where: { id: payout.id },
        data: { state: 'SENT', txHash: 'btest' + payout.id, height: 205, sentAt: new Date() }
      })
    }
    return { sent: payouts.length, failed: 0, skipped: 0 }
  })
}

test('a FUNDED bounty past bountyExpiryDays flips to EXPIRED', async () => {
  const userId = await createUser()
  const item = await createBountyPost(userId, {
    confirmedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
  })

  await runBountiesOnce({ models: prisma, sendBountyPayments: makeSendStub(), getHeight: async () => 209 })

  const after = await prisma.item.findUnique({ where: { id: item.id } })
  expect(after.bountyStatus).toBe('EXPIRED')
})

test('a freshly funded bounty stays FUNDED inside the expiry window', async () => {
  const userId = await createUser()
  const item = await createBountyPost(userId)

  await runBountiesOnce({ models: prisma, sendBountyPayments: makeSendStub(), getHeight: async () => 209 })

  const after = await prisma.item.findUnique({ where: { id: item.id } })
  expect(after.bountyStatus).toBe('FUNDED')
})

test('QUEUED AWARD payouts are dispatched by the signer (QUEUED -> SENT)', async () => {
  const authorId = await createUser()
  const winnerId = await createUser()
  const item = await createBountyPost(authorId)
  const payout = await seedPayout(item.id, winnerId, { state: 'QUEUED' })
  const send = makeSendStub()

  await runBountiesOnce({ models: prisma, sendBountyPayments: send, getHeight: async () => 209 })

  expect(send).toHaveBeenCalledWith(
    expect.arrayContaining([expect.objectContaining({ id: payout.id, state: 'QUEUED' })]),
    { models: prisma }
  )
  const after = await prisma.bountyPayment.findUnique({ where: { id: payout.id } })
  expect(after.state).toBe('SENT')
  expect(after.txHash).toBe('btest' + payout.id)
  expect(after.sentAt).toBeInstanceOf(Date)
})

test('a SENT payout with a height matures to CONFIRMED at REQUIRED_CONFIRMATIONS (10 confs)', async () => {
  const authorId = await createUser()
  const winnerId = await createUser()
  const item = await createBountyPost(authorId)
  const payout = await seedPayout(item.id, winnerId, { state: 'SENT', height: 200 })

  await runBountiesOnce({ models: prisma, sendBountyPayments: makeSendStub(), getHeight: async () => 209 })

  const after = await prisma.bountyPayment.findUnique({ where: { id: payout.id } })
  expect(after.state).toBe('CONFIRMED')
  expect(after.confirmations).toBe(10)
  expect(after.confirmedAt).toBeInstanceOf(Date)
})

test('a SENT payout stays SENT below REQUIRED_CONFIRMATIONS (9 confs)', async () => {
  const authorId = await createUser()
  const winnerId = await createUser()
  const item = await createBountyPost(authorId)
  const payout = await seedPayout(item.id, winnerId, { state: 'SENT', height: 200 })

  await runBountiesOnce({ models: prisma, sendBountyPayments: makeSendStub(), getHeight: async () => 208 })

  const after = await prisma.bountyPayment.findUnique({ where: { id: payout.id } })
  expect(after.state).toBe('SENT')
  expect(after.confirmations).toBe(0)
  expect(after.confirmedAt).toBeNull()
})
