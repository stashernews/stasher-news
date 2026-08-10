/* eslint-env jest */

// Funding-flow integration test (A-13 Task 3): initiateBountyFundingCore mints
// a per-bounty integrated address on the ESCROW wallet carrying a "bn:"
// payment id, registers the lws tx-confirmation webhook, records the
// BountyPidMap + a PENDING ObservedBounty, and returns the monero: URI
// (bounty + fee in one payment). driveBountyFunding is the webhook's CONFIRMED
// branch: it flips the ObservedBounty to CONFIRMED, flips the Item to FUNDED
// with the ACTUAL on-chain piconeros, and books the BOUNTY_FEE ledger row
// born CONFIRMED at the funding height.
//
// The lwsClient is stubbed (DI seam on the Apollo `monero` context); everything
// else is real DB behaviour against a live, migrated database — mirroring
// test/api/resolvers/monero.test.js.

import { PrismaClient } from '@prisma/client'
import { initiateBountyFundingCore } from '@/api/resolvers/bounty'
import { driveBountyFunding } from '@/pages/api/monero/webhook'
import { REQUIRED_CONFIRMATIONS } from '@/lib/constants'
import { bountyFeePiconeros } from '@/api/monero/bounties'

process.env.MONERO_NETWORK = 'stagenet'
process.env.LWS_WEBHOOK_URL = 'http://app:3000/api/monero/webhook'

const prisma = new PrismaClient()

// 95-char stagenet-prefixed placeholder addresses (valid base58 for
// makeIntegratedAddress; unique per [address, network]).
const ESCROW_ADDR = '5' + '1'.repeat(94)
const PAYER_ADDR = '5' + '2'.repeat(94)

// Deterministic fee config: min 0.01 XMR / 1% — a 2 XMR funding pays 0.02 XMR,
// well above the min, so the pct branch of bountyFeePiconeros is exercised.
const FEE_CONFIG = { bountyFeeMinPiconeros: 10_000_000_000n, bountyFeePct: 1 }

const created = { users: [], items: [], accounts: [], pids: [], bounties: [] }

async function cleanupTracked () {
  await prisma.observedBounty.deleteMany({ where: { postId: { in: created.items } } })
  await prisma.bountyPidMap.deleteMany({ where: { postId: { in: created.items } } })
  await prisma.feeObservation.deleteMany({ where: { postId: { in: created.items }, feeType: 'BOUNTY_FEE' } })
  await prisma.moneroAccount.deleteMany({ where: { id: { in: created.accounts } } })
  await prisma.item.deleteMany({ where: { id: { in: created.items } } })
  await prisma.user.deleteMany({ where: { id: { in: created.users } } })
  created.users.length = 0
  created.items.length = 0
  created.accounts.length = 0
  created.pids.length = 0
  created.bounties.length = 0
}

afterEach(cleanupTracked)
afterAll(async () => {
  // Restore the live dev config row the suite pinned deterministically.
  if (configSnapshot) {
    await prisma.platformFeeConfig.update({ where: { id: 1 }, data: configSnapshot })
    configSnapshot = null
  }
  await cleanupTracked()
  await prisma.$disconnect()
})

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  const id = rows[0].id
  created.users.push(id)
  return id
}

async function createPost (userId, { bountyPiconeros = 5_000_000_000n, bountyStatus = 'UNFUNDED' } = {}) {
  const item = await prisma.item.create({
    data: { userId, title: 'test bounty post', status: 'ACTIVE', bountyPiconeros, bountyStatus }
  })
  created.items.push(item.id)
  return item
}

// The escrow MoneroAccount the core resolves via findFirst (label + network).
// Insert with an id BELOW any existing account so the resolver deterministically
// resolves OUR row (de-facto lowest-id-first ordering) even when the live dev
// DB already holds a registered bounty_escrow account.
async function seedEscrow () {
  const lowest = await prisma.moneroAccount.findFirst({ orderBy: { id: 'asc' } })
  const acct = await prisma.moneroAccount.create({
    data: {
      id: lowest ? lowest.id - 1 : undefined,
      ownerUserId: null,
      address: ESCROW_ADDR,
      label: 'bounty_escrow',
      network: 'STAGENET',
      status: 'ACTIVE'
    }
  })
  created.accounts.push(acct.id)
  return acct
}

async function seedPayer (userId) {
  const acct = await prisma.moneroAccount.create({
    data: {
      ownerUserId: userId,
      address: PAYER_ADDR,
      label: 'author',
      network: 'STAGENET',
      status: 'ACTIVE'
    }
  })
  created.accounts.push(acct.id)
  return acct
}

// Pin the fee config deterministically; restore the prior values afterwards.
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

function makeMockLws () {
  return { addWebhook: jest.fn().mockResolvedValue({ event_id: 'e1' }) }
}

test('initiateBountyFundingCore mints the integrated address, registers the webhook, and leaves a PENDING ObservedBounty', async () => {
  await ensureFeeConfig()
  const userId = await createUser()
  const item = await createPost(userId)
  const escrow = await seedEscrow()
  await seedPayer(userId)
  const monero = makeMockLws()

  const out = await initiateBountyFundingCore({ postId: item.id, models: prisma, monero, me: { id: userId } })

  // URI carries the escrow-derived integrated address + the bounty+fee amount
  // (tx_amount is decimal XMR: (5e9 bounty + 1e10 fee) piconeros = 0.015 XMR).
  expect(out.uri).toContain(`monero:${out.integratedAddress}?`)
  expect(out.uri).toContain('tx_amount=0.015')
  expect(out.uri).toContain(`tx_payment_id=${out.paymentId}`)
  expect(out.paymentId).toMatch(/^[0-9a-f]{16}$/)
  expect(out.feePiconeros).toBe(bountyFeePiconeros(item.bountyPiconeros, FEE_CONFIG))

  // The webhook registration targeted the escrow wallet with the bn: payment id.
  expect(monero.addWebhook).toHaveBeenCalledWith(expect.objectContaining({
    type: 'tx-confirmation',
    address: escrow.address,
    paymentId: out.paymentId,
    confirmations: REQUIRED_CONFIRMATIONS
  }))

  // BountyPidMap + PENDING ObservedBounty exist; the item is PENDING_FUNDING.
  const pid = await prisma.bountyPidMap.findUnique({ where: { paymentId: out.paymentId } })
  created.pids.push(pid.paymentId)
  expect(pid).toMatchObject({ postId: item.id, userId, consumedAt: null })

  const bounty = await prisma.observedBounty.findFirst({ where: { paymentId: out.paymentId } })
  created.bounties.push(bounty.id)
  expect(bounty).toMatchObject({
    txHash: `pending-${out.paymentId}`,
    postId: item.id,
    payerId: userId,
    recipientAccountId: escrow.id,
    paymentId: out.paymentId,
    piconeros: 5_000_000_000n,
    height: null,
    state: 'PENDING',
    webhookEventId: 'e1'
  })

  const after = await prisma.item.findUnique({ where: { id: item.id } })
  expect(after.bountyStatus).toBe('PENDING_FUNDING')
})

test('driveBountyFunding confirms the funding with the ACTUAL on-chain amount and books the BOUNTY_FEE ledger row', async () => {
  await ensureFeeConfig()
  const userId = await createUser()
  const item = await createPost(userId)
  await seedEscrow()
  await seedPayer(userId)

  const out = await initiateBountyFundingCore({ postId: item.id, models: prisma, monero: makeMockLws(), me: { id: userId } })
  const bounty = await prisma.observedBounty.findFirst({ where: { paymentId: out.paymentId } })
  created.bounties.push(bounty.id)

  // The payer actually sent a different amount than the expected bounty.
  const observed = 2_000_000_000_000n
  const txHash = 'ab'.repeat(32)
  await prisma.$transaction(async (tx) => {
    await driveBountyFunding(tx, bounty, { txHash, height: 123456, confirmations: 10, piconeros: observed })
  })

  const afterBounty = await prisma.observedBounty.findUnique({ where: { id: bounty.id } })
  expect(afterBounty.state).toBe('CONFIRMED')
  expect(afterBounty.txHash).toBe(txHash)
  expect(afterBounty.height).toBe(123456)
  expect(afterBounty.confirmations).toBe(10)
  expect(afterBounty.confirmedAt).toBeInstanceOf(Date)

  // The item flips to FUNDED with the OBSERVED amount (not the expected 5e9).
  const afterItem = await prisma.item.findUnique({ where: { id: item.id } })
  expect(afterItem.bountyStatus).toBe('FUNDED')
  expect(afterItem.bountyPiconeros).toBe(observed)
  expect(afterItem.bountyConfirmedAt).toBeInstanceOf(Date)

  // BOUNTY_FEE booked born-CONFIRMED at the funding height, computed from the
  // observed amount: max(2e12 / 100, 1e10) = 2e10 (NOT the 1e10 min the
  // expected 5e9 would have produced).
  const fee = await prisma.feeObservation.findFirst({ where: { txHash, feeType: 'BOUNTY_FEE' } })
  expect(fee).toMatchObject({
    payInId: null,
    postId: item.id,
    recipientMajor: 0,
    recipientMinor: 0,
    piconeros: bountyFeePiconeros(observed, FEE_CONFIG),
    height: 123456,
    state: 'CONFIRMED'
  })
  expect(fee.piconeros).toBe(20_000_000_000n)
  expect(fee.confirmedAt).toBeInstanceOf(Date)
})

test('rejects a bounty below the BOUNTY_MIN_PICONEROS floor', async () => {
  await ensureFeeConfig()
  const userId = await createUser()
  const item = await createPost(userId, { bountyPiconeros: 1_000n })
  await seedEscrow()
  await seedPayer(userId)

  await expect(initiateBountyFundingCore({ postId: item.id, models: prisma, monero: makeMockLws(), me: { id: userId } }))
    .rejects.toThrow('bounty below minimum (1000000000 piconeros)')
})

test('rejects funding a bounty that is not UNFUNDED', async () => {
  await ensureFeeConfig()
  const userId = await createUser()
  const item = await createPost(userId, { bountyStatus: 'FUNDED' })
  await seedEscrow()
  await seedPayer(userId)

  await expect(initiateBountyFundingCore({ postId: item.id, models: prisma, monero: makeMockLws(), me: { id: userId } }))
    .rejects.toThrow('bounty is already funded or being funded')
})

test('rejects when the caller is not logged in', async () => {
  await ensureFeeConfig()
  const userId = await createUser()
  const item = await createPost(userId)
  await seedEscrow()

  await expect(initiateBountyFundingCore({ postId: item.id, models: prisma, monero: makeMockLws(), me: null }))
    .rejects.toThrow('you must be logged in')
})

test('rejects when the payer has no registered wallet (needed for reclaim attribution)', async () => {
  await ensureFeeConfig()
  const userId = await createUser()
  const item = await createPost(userId)
  await seedEscrow()

  await expect(initiateBountyFundingCore({ postId: item.id, models: prisma, monero: makeMockLws(), me: { id: userId } }))
    .rejects.toThrow('you must attach a wallet to fund a bounty')
})
