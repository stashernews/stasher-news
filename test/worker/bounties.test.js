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
import { BOUNTY_UNDERPAY_ABANDON_DAYS } from '@/lib/constants'

const prisma = new PrismaClient()

const ADDR = '5' + '3'.repeat(94) // 95-char Monero address placeholder

// Tracks every row created across tests so afterAll can tear them down in
// FK-safe order: BountyPayment -> FeeObservation -> ObservedBounty ->
// MoneroAccount -> Item -> users.
const created = { users: [], items: [], payments: [], accounts: [], bounties: [], fees: [] }

// Pin the fee config deterministically (min 0.01 XMR / 1% — same regime as
// test/api/bountyFunding.test.js, so the underfunded fixture math is exact:
// declared 1e12 -> fee 1e10 -> expected 1.01e12); restore the prior values
// in afterAll.
const FEE_CONFIG = { bountyFeeMinPiconeros: 10_000_000_000n, bountyFeePct: 1 }
let configSnapshot = null
async function ensureFeeConfig () {
  const before = await prisma.platformFeeConfig.findUnique({ where: { id: 1 } })
  if (!before) throw new Error('PlatformFeeConfig(id=1) missing — run migrations/seed first')
  configSnapshot = { bountyFeeMinPiconeros: before.bountyFeeMinPiconeros, bountyFeePct: before.bountyFeePct }
  await prisma.platformFeeConfig.update({
    where: { id: 1 },
    data: FEE_CONFIG
  })
}

afterAll(async () => {
  await prisma.bountyPayment.deleteMany({ where: { id: { in: created.payments } } })
  await prisma.feeObservation.deleteMany({ where: { id: { in: created.fees } } })
  await prisma.observedBounty.deleteMany({ where: { id: { in: created.bounties } } })
  await prisma.moneroAccount.deleteMany({ where: { id: { in: created.accounts } } })
  for (const id of created.items) {
    await prisma.itemUserAgg.deleteMany({ where: { itemId: id } })
    await prisma.item.deleteMany({ where: { id } })
  }
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } })
  // Restore the live dev config row the suite pinned deterministically.
  if (configSnapshot) {
    await prisma.platformFeeConfig.update({ where: { id: 1 }, data: configSnapshot })
    configSnapshot = null
  }
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
async function seedPayout (itemId, winnerUserId, { state, height, txHash = null, feePiconeros = 0n, feePendingAt = null } = {}) {
  const payout = await prisma.bountyPayment.create({
    data: {
      itemId,
      winnerUserId,
      piconeros: 5_000_000_000n,
      feePiconeros,
      recipientAddress: ADDR,
      kind: 'AWARD',
      state,
      height,
      txHash,
      feePendingAt
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

  await runBountiesOnce({ models: prisma, sendBountyPayments: makeSendStub(), getHeight: async () => 209, getTxHeight: async () => 200 })

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

  await runBountiesOnce({ models: prisma, sendBountyPayments: makeSendStub(), getHeight: async () => 208, getTxHeight: async () => 200 })

  const after = await prisma.bountyPayment.findUnique({ where: { id: payout.id } })
  expect(after.state).toBe('SENT')
  expect(after.confirmations).toBe(0)
  expect(after.confirmedAt).toBeNull()
})

test('a SENT payout with NULL height matures to CONFIRMED once its tx height is backfilled from lws', async () => {
  const authorId = await createUser()
  const winnerId = await createUser()
  const item = await createBountyPost(authorId)
  const payout = await seedPayout(item.id, winnerId, { state: 'SENT', height: null, txHash: 'btest-nullheight' })

  await runBountiesOnce({
    models: prisma,
    sendBountyPayments: jest.fn().mockResolvedValue({ sent: 0, failed: 0, skipped: 0 }),
    getHeight: async () => 209,
    getTxHeight: async () => 200
  })

  const after = await prisma.bountyPayment.findUnique({ where: { id: payout.id } })
  expect(after.state).toBe('CONFIRMED')
  expect(after.height).toBe(200)
  expect(after.confirmations).toBe(10)
  expect(after.confirmedAt).toBeInstanceOf(Date)
})

test('a SENT payout with NULL height stays SENT while its tx is unmined (height not yet backfilled)', async () => {
  const authorId = await createUser()
  const winnerId = await createUser()
  const item = await createBountyPost(authorId)
  const payout = await seedPayout(item.id, winnerId, { state: 'SENT', height: null, txHash: 'btest-unmined' })

  await runBountiesOnce({
    models: prisma,
    sendBountyPayments: jest.fn().mockResolvedValue({ sent: 0, failed: 0, skipped: 0 }),
    getHeight: async () => 209,
    getTxHeight: async () => null
  })

  const after = await prisma.bountyPayment.findUnique({ where: { id: payout.id } })
  expect(after.state).toBe('SENT')
  expect(after.height).toBeNull()
  expect(after.confirmedAt).toBeNull()
})

test('a SENT payout with NULL height stays SENT below REQUIRED_CONFIRMATIONS after backfill (9 confs)', async () => {
  const authorId = await createUser()
  const winnerId = await createUser()
  const item = await createBountyPost(authorId)
  const payout = await seedPayout(item.id, winnerId, { state: 'SENT', height: null, txHash: 'btest-9conf' })

  await runBountiesOnce({
    models: prisma,
    sendBountyPayments: jest.fn().mockResolvedValue({ sent: 0, failed: 0, skipped: 0 }),
    getHeight: async () => 208,
    getTxHeight: async () => 200
  })

  const after = await prisma.bountyPayment.findUnique({ where: { id: payout.id } })
  expect(after.state).toBe('SENT')
  expect(after.height).toBe(200) // height persisted even though not yet mature
  expect(after.confirmedAt).toBeNull()
})

const ESCROW_ADDR = '5' + '4'.repeat(94)

async function seedEscrowAccount () {
  const acct = await prisma.moneroAccount.create({
    data: { ownerUserId: null, address: ESCROW_ADDR + String(itemSeq), label: 'bounty_escrow', network: 'STAGENET', status: 'ACTIVE' }
  })
  created.accounts.push(acct.id)
  return acct
}

// A partially-funded DETECTED bounty: declared 1e12 (fee would be pinned by
// config below to 1e10, expected 1.01e12) but only 6e11 ever arrived, detected
// ABANDON_DAYS ago. The receipt mirrors real funding state: one received tx at
// known height by default; receiptHeight null models a daemon-verified
// provisional receipt (display-only, never refundable by abandonment).
async function seedUnderfundedBounty (userId, { received = 600_000_000_000n, ageDays = BOUNTY_UNDERPAY_ABANDON_DAYS + 1, receiptHeight = 100 } = {}) {
  const escrow = await seedEscrowAccount()
  itemSeq += 1
  const item = await prisma.item.create({
    data: {
      userId,
      title: 'underfunded fixture ' + itemSeq,
      status: 'ACTIVE',
      bountyPiconeros: 1_000_000_000_000n,
      bountyStatus: 'PENDING_FUNDING'
    }
  })
  created.items.push(item.id)
  const bounty = await prisma.observedBounty.create({
    data: {
      txHash: 'uf-' + item.id,
      postId: item.id,
      payerId: userId,
      recipientAccountId: escrow.id,
      paymentId: 'bn' + item.id,
      piconeros: received,
      height: receiptHeight,
      state: 'DETECTED',
      detectedAt: new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000)
    }
  })
  created.bounties.push(bounty.id)
  if (received > 0n) {
    await prisma.observedBountyReceipt.create({
      data: { bountyId: bounty.id, txHash: 'ufr-' + item.id, piconeros: received, height: receiptHeight }
    })
  }
  return { item, bounty }
}

test('underfunded DETECTED bounties are abandoned after 7 days: EXPIRED, bountyPiconeros=received, zero-fee row', async () => {
  await ensureFeeConfig()
  const userId = await createUser()
  const { item } = await seedUnderfundedBounty(userId)

  await runBountiesOnce({ models: prisma, sendBountyPayments: jest.fn().mockResolvedValue({ sent: 0, failed: 0, skipped: 0 }), getHeight: async () => 1_000_000 })

  const afterItem = await prisma.item.findUnique({ where: { id: item.id } })
  expect(afterItem.bountyStatus).toBe('EXPIRED')
  expect(afterItem.bountyPiconeros).toBe(600_000_000_000n)

  const bounty = await prisma.observedBounty.findFirst({ where: { postId: item.id } })
  expect(bounty.state).toBe('EXPIRED')

  // the zero-fee row makes bookedBountyFeePiconeros read 0n at disposition:
  // reclaim pays exactly what was received (fee-waived refund)
  const fee = await prisma.feeObservation.findFirst({ where: { postId: item.id, feeType: 'BOUNTY_FEE' } })
  expect(fee).toBeTruthy()
  expect(fee.piconeros).toBe(0n)
  if (fee) created.fees.push(fee.id)
})

test('a fresh underfunded bounty (inside the window) is NOT abandoned', async () => {
  await ensureFeeConfig()
  const userId = await createUser()
  const { item } = await seedUnderfundedBounty(userId, { ageDays: 1 })

  await runBountiesOnce({ models: prisma, sendBountyPayments: jest.fn().mockResolvedValue({ sent: 0, failed: 0, skipped: 0 }), getHeight: async () => 1_000_000 })

  const afterItem = await prisma.item.findUnique({ where: { id: item.id } })
  expect(afterItem.bountyStatus).toBe('PENDING_FUNDING')
})

test('a fully-received DETECTED bounty past the window is NOT abandoned (awaiting confirm)', async () => {
  await ensureFeeConfig()
  const userId = await createUser()
  const { item } = await seedUnderfundedBounty(userId, { received: 1_010_000_000_000n })

  await runBountiesOnce({ models: prisma, sendBountyPayments: jest.fn().mockResolvedValue({ sent: 0, failed: 0, skipped: 0 }), getHeight: async () => 1_000_000 })

  const afterItem = await prisma.item.findUnique({ where: { id: item.id } })
  expect(afterItem.bountyStatus).toBe('PENDING_FUNDING')
})

test('abandonment counts only chain-verified receipts: a provisional (height-null) claim cannot cover the quote', async () => {
  // The display fold covers the full quote, but the only receipt is a
  // daemon-verified 0-conf claim (height NULL, amount unverifiable) — it must
  // not hold the abandonment open nor be refunded as "received".
  await ensureFeeConfig()
  const userId = await createUser()
  const { item } = await seedUnderfundedBounty(userId, { received: 1_010_000_000_000n, receiptHeight: null })

  await runBountiesOnce({ models: prisma, sendBountyPayments: jest.fn().mockResolvedValue({ sent: 0, failed: 0, skipped: 0 }), getHeight: async () => 1_000_000 })

  const afterItem = await prisma.item.findUnique({ where: { id: item.id } })
  expect(afterItem.bountyStatus).toBe('EXPIRED')
  // Nothing count-eligible was received, so the refund is booked at zero —
  // a provisional claim never sets the refund total.
  expect(afterItem.bountyPiconeros).toBe(0n)
  const bounty = await prisma.observedBounty.findFirst({ where: { postId: item.id } })
  expect(bounty.state).toBe('EXPIRED')
})

test('SENT payouts with a deferred fee are offered to the signer for fee settlement', async () => {
  const authorId = await createUser()
  const winnerId = await createUser()
  const item = await createBountyPost(authorId)
  const payout = await seedPayout(item.id, winnerId, {
    state: 'SENT',
    height: 200,
    feePiconeros: 10_000_000_000n,
    feePendingAt: new Date()
  })
  const send = jest.fn().mockResolvedValue({ sent: 0, failed: 0, skipped: 0, settled: 1 })

  await runBountiesOnce({
    models: prisma,
    sendBountyPayments: send,
    getHeight: async () => 209,
    getTxHeight: async () => 200
  })

  expect(send).toHaveBeenCalledWith(
    expect.arrayContaining([expect.objectContaining({ id: payout.id, state: 'SENT', feePendingAt: expect.any(Date) })]),
    { models: prisma }
  )
})

test('a CONFIRMED payout with a still-deferred fee is still offered to the signer for fee settlement', async () => {
  const authorId = await createUser()
  const winnerId = await createUser()
  const item = await createBountyPost(authorId)
  const payout = await seedPayout(item.id, winnerId, {
    state: 'CONFIRMED',
    height: 200,
    feePiconeros: 10_000_000_000n,
    feePendingAt: new Date()
  })
  const send = jest.fn().mockResolvedValue({ sent: 0, failed: 0, skipped: 0, settled: 1 })

  await runBountiesOnce({
    models: prisma,
    sendBountyPayments: send,
    getHeight: async () => 209,
    getTxHeight: async () => 200
  })

  expect(send).toHaveBeenCalledWith(
    expect.arrayContaining([expect.objectContaining({ id: payout.id, state: 'CONFIRMED', feePendingAt: expect.any(Date) })]),
    { models: prisma }
  )
})

test('a QUEUED payout with a stale feePendingAt is offered to the signer exactly ONCE (never double-dispatched)', async () => {
  const authorId = await createUser()
  const winnerId = await createUser()
  const item = await createBountyPost(authorId)
  // Manual-requeue hazard shape: state QUEUED but feePendingAt still set.
  const payout = await seedPayout(item.id, winnerId, {
    state: 'QUEUED',
    feePendingAt: new Date(),
    feePiconeros: 10_000_000_000n
  })
  const seen = []
  const send = jest.fn(async (payouts) => {
    for (const p of payouts) seen.push(p.id)
    return { sent: 0, failed: 0, skipped: 0, settled: 0 }
  })

  await runBountiesOnce({ models: prisma, sendBountyPayments: send, getHeight: async () => 209 })

  expect(seen.filter(id => id === payout.id)).toHaveLength(1)
})
