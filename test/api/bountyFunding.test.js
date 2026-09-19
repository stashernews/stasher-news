/* eslint-env jest */

// Funding-flow integration test (A-13 Task 3): initiateBountyFundingCore mints
// a per-bounty integrated address on the ESCROW wallet carrying a "bn:"
// payment id, registers the lws tx-confirmation webhook, records the
// BountyPidMap + a PENDING ObservedBounty, and returns the monero: URI
// (bounty + fee in one payment). driveBountyFunding is the webhook's CONFIRMED
// branch: it flips the ObservedBounty to CONFIRMED, flips the Item to FUNDED
// with bountyPiconeros = observed − fee (net of the platform fee, so
// dispositions can zero the escrow exactly), and books the BOUNTY_FEE ledger
// row born CONFIRMED at the funding height.
//
// The lwsClient is stubbed (DI seam on the Apollo `monero` context); everything
// else is real DB behaviour against a live, migrated database — mirroring
// test/api/resolvers/monero.test.js.

import { PrismaClient } from '@prisma/client'
import { initiateBountyFundingCore } from '@/api/resolvers/bounty'
import { driveBountyFunding, recordBountyReceipt, bountyExpectedPiconeros, handleWebhook } from '@/pages/api/monero/webhook'
import { updateItem } from '@/api/resolvers/item'
import { REQUIRED_CONFIRMATIONS } from '@/lib/constants'
import { bountyFeePiconeros } from '@/api/monero/bounties'
import { alert } from '@/lib/alert'

// The corrected-amount alert (provisional callback amount != lws-verified
// amount at the height transition) pages operators; capture the calls without
// a network side effect. Everything else in lib/alert stays real.
jest.mock(`${process.cwd()}/lib/alert`, () => {
  const actual = jest.requireActual(`${process.cwd()}/lib/alert`)
  return { ...actual, alert: jest.fn() }
})

// item.js statically imports @/lib/lexical/server/mentions (ESM-only
// mdast-util-from-markdown) via the payIn engine, and @/lib/lexical/server/html
// (ESM-only github-slugger via the headless editor); updateItem exercises
// neither, so stub both like test/engine/payInItemUpdate.test.js. jest.mock is
// hoisted above the imports, so the stubs are in place when item.js loads.
jest.mock('../../lib/lexical/server/mentions', () => ({
  __esModule: true,
  extractMentions: () => ({ userNames: [], itemIds: [] })
}))
jest.mock('../../lib/lexical/server/html', () => ({
  __esModule: true,
  lexicalHTMLGenerator: () => ({ html: '', text: '' })
}))

process.env.MONERO_NETWORK = 'stagenet'
process.env.LWS_WEBHOOK_URL = 'http://app:3000/api/monero/webhook'

const prisma = new PrismaClient()

// 95-char stagenet-prefixed placeholder addresses (valid base58 for
// makeIntegratedAddress; unique per [address, network]).
const ESCROW_ADDR = '5' + '1'.repeat(94)
const PAYER_ADDR = '5' + '2'.repeat(94)

// Deterministic fee config: min 0.01 XMR / 1%. The CONFIRMED-branch test pays
// the full 1.01 XMR quote on a 1 XMR declared bounty, where the min fee
// (0.01 XMR) dominates — the floor regime gives exact, readable math
// (declared 1e12 → fee 1e10 → bounty = 1.01e12 − 1e10 = 1e12).
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

async function createPost (userId, { bountyPiconeros = 1_000_000_000_000n, bountyStatus = 'UNFUNDED' } = {}) {
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
  // (tx_amount is decimal XMR: (1e12 bounty + 1e10 fee) piconeros = 1.01 XMR).
  expect(out.uri).toContain(`monero:${out.integratedAddress}?`)
  expect(out.uri).toContain('tx_amount=1.01')
  // The integrated address embeds the payment id; the URI must NOT also carry
  // tx_payment_id (Feather wallet2 parse_uri rejects that combination).
  expect(out.uri).not.toContain('tx_payment_id')
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
    piconeros: 1_000_000_000_000n,
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

  // The payer sent the full quoted total: 1.01 XMR (declared 1 + min fee
  // 0.01). The fee is booked from the DECLARED bounty (1e12), where the min
  // fee (0.01 XMR) dominates — the floor regime gives exact, readable math
  // (declared 1e12 → fee 1e10 → bounty = 1.01e12 − 1e10 = 1e12).
  const observed = 1_010_000_000_000n
  const feePiconeros = bountyFeePiconeros(item.bountyPiconeros, FEE_CONFIG)
  expect(feePiconeros).toBe(10_000_000_000n)
  const txHash = 'ab'.repeat(32)
  await prisma.$transaction(async (tx) => {
    await recordBountyReceipt(tx, bounty, { txHash, piconeros: observed, height: 123456 })
    await driveBountyFunding(tx, bounty, { txHash, height: 123456, confirmations: 10 })
  })

  const afterBounty = await prisma.observedBounty.findUnique({ where: { id: bounty.id } })
  expect(afterBounty.state).toBe('CONFIRMED')
  expect(afterBounty.txHash).toBe(txHash)
  expect(afterBounty.height).toBe(123456)
  expect(afterBounty.confirmations).toBe(10)
  expect(afterBounty.confirmedAt).toBeInstanceOf(Date)

  // The item flips to FUNDED with the observed amount NET of the platform fee
  // (bountyPiconeros = observed − fee = 1e12, not the raw 1.01e12) so the signer
  // can zero the escrow exactly at disposition.
  const afterItem = await prisma.item.findUnique({ where: { id: item.id } })
  expect(afterItem.bountyStatus).toBe('FUNDED')
  expect(afterItem.bountyPiconeros).toBe(observed - feePiconeros)
  expect(afterItem.bountyConfirmedAt).toBeInstanceOf(Date)

  // BOUNTY_FEE booked born-CONFIRMED at the funding height, computed from the
  // declared bounty: max(1e12 / 100, 1e10) = 1e10 — the min-fee floor dominates
  // (1% of 1e12 is only 1e10, exactly the floor).
  const fee = await prisma.feeObservation.findFirst({ where: { txHash, feeType: 'BOUNTY_FEE' } })
  expect(fee).toMatchObject({
    payInId: null,
    postId: item.id,
    recipientMajor: 0,
    recipientMinor: 0,
    piconeros: feePiconeros,
    height: 123456,
    state: 'CONFIRMED'
  })
  expect(fee.piconeros).toBe(10_000_000_000n)
  expect(fee.confirmedAt).toBeInstanceOf(Date)
})

// Regression (2026-08-11 live, items/5227): a minimum bounty (0.01 XMR) paid at
// its quoted total (0.012 = 0.01 bounty + 0.002 fee) used to book the fee from
// the OBSERVED amount — where the 20% cap binds below the 0.01 floor — shorting
// the bounty to 0.0096, BELOW BOUNTY_MIN_PICONEROS. The fee must come from the
// DECLARED bounty, so paying the quoted total books exactly the declared 0.01.
test('driveBountyFunding books the fee from the DECLARED bounty: a minimum bounty paid at its quote books exactly 0.01', async () => {
  await ensureFeeConfig()
  const userId = await createUser()
  const item = await createPost(userId, { bountyPiconeros: 10_000_000_000n })
  await seedEscrow()
  await seedPayer(userId)

  const out = await initiateBountyFundingCore({ postId: item.id, models: prisma, monero: makeMockLws(), me: { id: userId } })
  const bounty = await prisma.observedBounty.findFirst({ where: { paymentId: out.paymentId } })
  created.bounties.push(bounty.id)

  // Quoted total: 0.01 bounty + 0.002 fee (fee on the declared bounty:
  // max(1e8, 1e10) capped at 20% of 1e10 = 2e9). The payer sends exactly it.
  expect(out.feePiconeros).toBe(2_000_000_000n)
  const observed = 12_000_000_000n
  const txHash = '52'.repeat(32)
  await prisma.$transaction(async (tx) => {
    await recordBountyReceipt(tx, bounty, { txHash, piconeros: observed, height: 123457 })
    await driveBountyFunding(tx, bounty, { txHash, height: 123457, confirmations: 10 })
  })

  // Booked exactly the declared minimum — never below BOUNTY_MIN_PICONEROS.
  const afterItem = await prisma.item.findUnique({ where: { id: item.id } })
  expect(afterItem.bountyStatus).toBe('FUNDED')
  expect(afterItem.bountyPiconeros).toBe(10_000_000_000n)

  // BOUNTY_FEE booked from the declared bounty (2e9), not the observed 2.4e9.
  const fee = await prisma.feeObservation.findFirst({ where: { txHash, feeType: 'BOUNTY_FEE' } })
  expect(fee.piconeros).toBe(2_000_000_000n)
})

test('re-entry: PENDING_FUNDING returns the SAME payment id and integrated address without re-minting', async () => {
  await ensureFeeConfig()
  const userId = await createUser()
  const item = await createPost(userId)
  await seedEscrow()
  await seedPayer(userId)
  const monero = makeMockLws()

  const first = await initiateBountyFundingCore({ postId: item.id, models: prisma, monero, me: { id: userId } })
  expect(monero.addWebhook).toHaveBeenCalledTimes(1)

  // The user closed the funding view; reopening it (fund-bounty button on the
  // post page) calls fundBounty again while the item is still PENDING_FUNDING.
  const second = await initiateBountyFundingCore({ postId: item.id, models: prisma, monero, me: { id: userId } })

  expect(second.paymentId).toBe(first.paymentId)
  expect(second.integratedAddress).toBe(first.integratedAddress)
  expect(second.uri).toBe(first.uri)
  expect(second.feePiconeros).toBe(first.feePiconeros)

  // No second webhook registration, no second pid map or ObservedBounty row.
  expect(monero.addWebhook).toHaveBeenCalledTimes(1)
  const pidMaps = await prisma.bountyPidMap.findMany({ where: { postId: item.id } })
  expect(pidMaps).toHaveLength(1)
  const bounties = await prisma.observedBounty.findMany({ where: { postId: item.id } })
  expect(bounties).toHaveLength(1)

  const after = await prisma.item.findUnique({ where: { id: item.id } })
  expect(after.bountyStatus).toBe('PENDING_FUNDING')
})

test('re-entry after DETECTED (pid map consumed, payment in flight) returns the SAME payment id without re-minting', async () => {
  await ensureFeeConfig()
  const userId = await createUser()
  const item = await createPost(userId)
  await seedEscrow()
  await seedPayer(userId)
  const monero = makeMockLws()

  const first = await initiateBountyFundingCore({ postId: item.id, models: prisma, monero, me: { id: userId } })
  expect(monero.addWebhook).toHaveBeenCalledTimes(1)

  // Mirror the webhook's PENDING -> DETECTED writes: the 0-conf callback fired,
  // so the funding tx is on chain and the pid map is CONSUMED (it can never
  // fund a second bounty). The payment is now awaiting REQUIRED_CONFIRMATIONS.
  const txHash = 'cd'.repeat(32)
  const observed = 11_000_000_000n
  await prisma.$transaction(async (tx) => {
    const bounty = await tx.observedBounty.findFirst({ where: { paymentId: first.paymentId } })
    await tx.$executeRaw`
      UPDATE "ObservedBounty"
      SET state = 'DETECTED', "txHash" = ${txHash},
          height = ${100000}, piconeros = ${observed}, confirmations = ${0}
      WHERE id = ${bounty.id} AND state = 'PENDING'`
    await tx.bountyPidMap.update({
      where: { paymentId: first.paymentId },
      data: { consumedAt: new Date() }
    })
  })

  // The live pid map is gone, but the payment is still in flight — re-entry
  // must hand back the SAME address/payment id instead of minting a second URI
  // (paying twice would overfund the escrow for one bounty). The URI now
  // quotes the REMAINDER of the partial payment (1.01 quote − 0.011 received
  // = 0.999) so a top-up completes the funding, and the result reports
  // received/expected for the client hint.
  const second = await initiateBountyFundingCore({ postId: item.id, models: prisma, monero, me: { id: userId } })

  expect(second.paymentId).toBe(first.paymentId)
  expect(second.integratedAddress).toBe(first.integratedAddress)
  expect(second.uri).toContain('tx_amount=0.999')
  expect(second.feePiconeros).toBe(first.feePiconeros)
  expect(second.receivedPiconeros).toBe(observed)
  expect(second.expectedPiconeros).toBe(1_010_000_000_000n)

  // No second webhook registration, no second pid map or ObservedBounty row.
  expect(monero.addWebhook).toHaveBeenCalledTimes(1)
  const pidMaps = await prisma.bountyPidMap.findMany({ where: { postId: item.id } })
  expect(pidMaps).toHaveLength(1)
  expect(pidMaps[0].consumedAt).toBeInstanceOf(Date)
  const bounties = await prisma.observedBounty.findMany({ where: { postId: item.id } })
  expect(bounties).toHaveLength(1)
  expect(bounties[0].state).toBe('DETECTED')

  const after = await prisma.item.findUnique({ where: { id: item.id } })
  expect(after.bountyStatus).toBe('PENDING_FUNDING')
})

test('stale pid map: PENDING_FUNDING with an EXPIRED BountyPidMap mints a FRESH funding even while the PENDING ObservedBounty lingers', async () => {
  await ensureFeeConfig()
  const userId = await createUser()
  const item = await createPost(userId)
  await seedEscrow()
  await seedPayer(userId)
  const monero = makeMockLws()

  const first = await initiateBountyFundingCore({ postId: item.id, models: prisma, monero, me: { id: userId } })
  // Force the 24h pid-map expiry: the re-entry lookup (expiresAt > now) must
  // no longer match, so the next call falls through to a fresh mint.
  await prisma.bountyPidMap.update({
    where: { paymentId: first.paymentId },
    data: { expiresAt: new Date(Date.now() - 1000) }
  })
  // The ObservedBounty stays PENDING — the payment never arrived, and the
  // webhook's expiresAt guard rejects late arrivals, so the pid it carries is
  // stale/unconsumed. In-flight protection is DETECTED-only: a PENDING row can
  // only coexist with a stale pid (a live pid would be caught above), so
  // returning its dead address here would strand this re-entry for good — the
  // fresh mint must fire instead.
  // The fresh mint's crypto-random 8-byte nonce yields a distinct payment id
  // without a timestamp gap.
  const second = await initiateBountyFundingCore({ postId: item.id, models: prisma, monero, me: { id: userId } })

  expect(second.paymentId).toMatch(/^[0-9a-f]{16}$/)
  expect(second.paymentId).not.toBe(first.paymentId)
  expect(second.integratedAddress).not.toBe(first.integratedAddress)
  expect(second.feePiconeros).toBe(first.feePiconeros)
  expect(monero.addWebhook).toHaveBeenCalledTimes(2)
  expect(monero.addWebhook.mock.calls[1][0]).toMatchObject({ paymentId: second.paymentId })

  // The stale map + PENDING row remain (payment ids are one-shot), and the
  // fresh mint added exactly one more of each.
  const pidMaps = await prisma.bountyPidMap.findMany({ where: { postId: item.id } })
  expect(pidMaps).toHaveLength(2)
  const bounties = await prisma.observedBounty.findMany({ where: { postId: item.id } })
  expect(bounties).toHaveLength(2)
  expect(bounties.find(b => b.paymentId === first.paymentId).state).toBe('PENDING')
  expect(bounties.find(b => b.paymentId === second.paymentId).state).toBe('PENDING')

  const after = await prisma.item.findUnique({ where: { id: item.id } })
  expect(after.bountyStatus).toBe('PENDING_FUNDING')
})

test('rejects a bounty below the BOUNTY_MIN_PICONEROS floor', async () => {
  await ensureFeeConfig()
  const userId = await createUser()
  const item = await createPost(userId, { bountyPiconeros: 1_000n })
  await seedEscrow()
  await seedPayer(userId)

  await expect(initiateBountyFundingCore({ postId: item.id, models: prisma, monero: makeMockLws(), me: { id: userId } }))
    .rejects.toThrow('bounty below minimum (10000000000 piconeros)')
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

test('rejects a funder who is not the bounty author (A-13 final: ownership check)', async () => {
  await ensureFeeConfig()
  const authorId = await createUser()
  const strangerId = await createUser()
  const item = await createPost(authorId)
  await seedEscrow()
  await seedPayer(strangerId)

  // The stranger's payment would be unrecoverable: reclaim pays the AUTHOR,
  // and a second funder's CONFIRMED would overwrite bountyPiconeros, orphaning
  // the first payment in escrow — so only the author may fund.
  await expect(initiateBountyFundingCore({ postId: item.id, models: prisma, monero: makeMockLws(), me: { id: strangerId } }))
    .rejects.toThrow('only the bounty author can fund it')

  // No pid map, ObservedBounty, or webhook was created for the stranger's call.
  const pidMaps = await prisma.bountyPidMap.findMany({ where: { postId: item.id } })
  expect(pidMaps).toHaveLength(0)
  const bounties = await prisma.observedBounty.findMany({ where: { postId: item.id } })
  expect(bounties).toHaveLength(0)
  const after = await prisma.item.findUnique({ where: { id: item.id } })
  expect(after.bountyStatus).toBe('UNFUNDED')
})

test('rejects when the payer has no registered wallet (needed for reclaim attribution)', async () => {
  await ensureFeeConfig()
  const userId = await createUser()
  const item = await createPost(userId)
  await seedEscrow()

  await expect(initiateBountyFundingCore({ postId: item.id, models: prisma, monero: makeMockLws(), me: { id: userId } }))
    .rejects.toThrow('you must attach a wallet to fund a bounty')
})

test('rejects changing the bounty amount on a FUNDED bounty (A-13 final: escrow desync gate)', async () => {
  const userId = await createUser()
  const item = await createPost(userId, { bountyPiconeros: 5_000_000_000n, bountyStatus: 'FUNDED' })

  await expect(updateItem(null, { id: item.id, bountyPiconeros: 6_000_000_000n }, { me: { id: userId }, models: prisma }))
    .rejects.toThrow('the bounty amount cannot be changed once funding is in progress or complete')

  const after = await prisma.item.findUnique({ where: { id: item.id } })
  expect(after.bountyPiconeros).toBe(5_000_000_000n)
  expect(after.bountyStatus).toBe('FUNDED')
})

// The gate comment claims the amount is frozen "from the moment funding is in
// progress", but PENDING_FUNDING was exempted: a bounty whose funding was
// minted but not yet paid could be re-amounted, desyncing the escrow from the
// already-minted quote/URI (a payer who sends the OLD quoted total gets a
// bounty booked on the NEW declared amount). Freeze from PENDING_FUNDING too;
// the author's escape hatch for a mis-entered amount is delete + recreate
// (deleteItemByAuthor is unaffected by this gate).
test('rejects changing the bounty amount on a PENDING_FUNDING bounty (funding quote already minted)', async () => {
  const userId = await createUser()
  const item = await createPost(userId, { bountyPiconeros: 10_000_000_000n, bountyStatus: 'PENDING_FUNDING' })

  await expect(updateItem(null, { id: item.id, bountyPiconeros: 12_000_000_000n }, { me: { id: userId }, models: prisma }))
    .rejects.toThrow('the bounty amount cannot be changed once funding is in progress or complete')

  const after = await prisma.item.findUnique({ where: { id: item.id } })
  expect(after.bountyPiconeros).toBe(10_000_000_000n)
  expect(after.bountyStatus).toBe('PENDING_FUNDING')
})

test('driveBountyFunding holds an underfunded bounty at DETECTED, books no fee, and returns false', async () => {
  await ensureFeeConfig()
  const userId = await createUser()
  const item = await createPost(userId)
  await seedEscrow()
  await seedPayer(userId)

  const out = await initiateBountyFundingCore({ postId: item.id, models: prisma, monero: makeMockLws(), me: { id: userId } })
  const bounty = await prisma.observedBounty.findFirst({ where: { paymentId: out.paymentId } })
  created.bounties.push(bounty.id)

  // received 0.5 XMR of the 1.01 XMR quote (declared 1 + fee 0.01)
  const shortObserved = 500_000_000_000n
  await prisma.$executeRaw`
    UPDATE "ObservedBounty"
    SET state = 'DETECTED', "txHash" = ${'ab'.repeat(32)}, height = ${100}, piconeros = ${shortObserved}
    WHERE id = ${bounty.id}`
  await prisma.bountyPidMap.update({ where: { paymentId: out.paymentId }, data: { consumedAt: new Date() } })

  let funded
  await prisma.$transaction(async (tx) => {
    await recordBountyReceipt(tx, bounty, { txHash: 'ab'.repeat(32), piconeros: shortObserved, height: 100 })
    funded = await driveBountyFunding(tx, bounty, { txHash: 'ab'.repeat(32), height: 100, confirmations: 10 })
  })

  expect(funded).toBe(false)
  const afterItem = await prisma.item.findUnique({ where: { id: item.id } })
  expect(afterItem.bountyStatus).toBe('PENDING_FUNDING')
  const afterBounty = await prisma.observedBounty.findUnique({ where: { id: bounty.id } })
  expect(afterBounty.state).toBe('DETECTED')
  const feeRows = await prisma.feeObservation.findMany({ where: { postId: item.id, feeType: 'BOUNTY_FEE' } })
  expect(feeRows).toHaveLength(0)
})

test('receipts accumulate: a top-up crosses the quote and funds with the cumulative total, booking exactly one fee', async () => {
  await ensureFeeConfig()
  const userId = await createUser()
  const item = await createPost(userId)
  await seedEscrow()
  await seedPayer(userId)

  const out = await initiateBountyFundingCore({ postId: item.id, models: prisma, monero: makeMockLws(), me: { id: userId } })
  const bounty = await prisma.observedBounty.findFirst({ where: { paymentId: out.paymentId } })
  created.bounties.push(bounty.id)

  // two partial payments: 0.6 XMR then 0.41 XMR — cumulative 1.01 = the quote
  let receipt
  await prisma.$transaction(async (tx) => {
    receipt = await recordBountyReceipt(tx, bounty, { txHash: 'cd'.repeat(32), piconeros: 600_000_000_000n, height: 100 })
    receipt = await recordBountyReceipt(tx, bounty, { txHash: 'ce'.repeat(32), piconeros: 410_000_000_000n, height: 101 })
    // retried callback for the FIRST tx is a no-op (idempotent by txHash; its
    // height was already claimed, so the CAS matches 0 rows)
    const replay = await recordBountyReceipt(tx, bounty, { txHash: 'cd'.repeat(32), piconeros: 600_000_000_000n, height: 100 })
    expect(replay.transitioned).toBe(false)
  })
  expect(receipt.display).toBe(1_010_000_000_000n)
  expect(receipt.counted).toBe(1_010_000_000_000n)
  expect(await bountyExpectedPiconeros(prisma, bounty)).toBe(1_010_000_000_000n)

  await prisma.bountyPidMap.update({ where: { paymentId: out.paymentId }, data: { consumedAt: new Date() } })
  let funded
  await prisma.$transaction(async (tx) => {
    funded = await driveBountyFunding(tx, bounty, { txHash: 'ce'.repeat(32), height: 101, confirmations: 10 })
  })

  expect(funded).toBe(true)
  const afterItem = await prisma.item.findUnique({ where: { id: item.id } })
  expect(afterItem.bountyStatus).toBe('FUNDED')
  expect(afterItem.bountyPiconeros).toBe(1_010_000_000_000n - 10_000_000_000n)
  const feeRows = await prisma.feeObservation.findMany({ where: { postId: item.id, feeType: 'BOUNTY_FEE' } })
  expect(feeRows).toHaveLength(1)
})

// --- zero-conf count-eligibility (Task 11) ---
//
// A receipt recorded from a daemon-level (0-conf) verdict is provisional: the
// tx + payment id + recipient output are proven, but the RingCT amount is not,
// so the row is inserted with height NULL and is DISPLAY-ONLY. Only the atomic
// NULL->height CAS (claimed by a chain-verified source: the lws callback or the
// finalizer's lws reconcile) makes a receipt count toward FUNDED. Replaying an
// already-height receipt matches zero CAS rows, so no value effect re-fires.

test('a provisional (height-null) receipt is displayed but never gates FUNDED', async () => {
  await ensureFeeConfig()
  const userId = await createUser()
  const item = await createPost(userId)
  await seedEscrow()
  await seedPayer(userId)

  const out = await initiateBountyFundingCore({ postId: item.id, models: prisma, monero: makeMockLws(), me: { id: userId } })
  const bounty = await prisma.observedBounty.findFirst({ where: { paymentId: out.paymentId } })
  created.bounties.push(bounty.id)

  // The daemon-verified 0-conf callback already claimed PENDING -> DETECTED
  // (the claim is what admits a provisional receipt); the pid map is consumed.
  await prisma.$executeRaw`
    UPDATE "ObservedBounty"
    SET state = 'DETECTED', "txHash" = ${'f1'.repeat(32)}, height = NULL,
        piconeros = ${1_010_000_000_000n}, confirmations = 0
    WHERE id = ${bounty.id}`
  await prisma.bountyPidMap.update({ where: { paymentId: out.paymentId }, data: { consumedAt: new Date() } })

  // The full quote arrived as a daemon-verified 0-conf callback: the amount is
  // the callback's claim, the height is unknown (mempool) — display-only.
  const txHash = 'f1'.repeat(32)
  const provisional = 1_010_000_000_000n
  let receipt
  await prisma.$transaction(async (tx) => {
    receipt = await recordBountyReceipt(tx, bounty, { txHash, piconeros: provisional, height: null })
  })
  expect(receipt.display).toBe(provisional)
  expect(receipt.counted).toBe(0n)
  expect(receipt.transitioned).toBe(false)

  // The display fold covers the quote...
  const displayed = await prisma.observedBounty.findUnique({ where: { id: bounty.id } })
  expect(displayed.piconeros).toBe(provisional)

  // ...but the FUNDED gate must ignore the provisional receipt entirely.
  let funded
  await prisma.$transaction(async (tx) => {
    funded = await driveBountyFunding(tx, bounty, { txHash, height: 100, confirmations: 10 })
  })
  expect(funded).toBe(false)
  const afterBounty = await prisma.observedBounty.findUnique({ where: { id: bounty.id } })
  expect(afterBounty.state).toBe('DETECTED')
  const afterItem = await prisma.item.findUnique({ where: { id: item.id } })
  expect(afterItem.bountyStatus).toBe('PENDING_FUNDING')
  const feeRows = await prisma.feeObservation.findMany({ where: { postId: item.id, feeType: 'BOUNTY_FEE' } })
  expect(feeRows).toHaveLength(0)
})

test('backfilling height makes the receipt count-eligible; the funding flips FUNDED on counted-fee and a replay never re-fires', async () => {
  await ensureFeeConfig()
  const userId = await createUser()
  const item = await createPost(userId)
  await seedEscrow()
  await seedPayer(userId)

  const out = await initiateBountyFundingCore({ postId: item.id, models: prisma, monero: makeMockLws(), me: { id: userId } })
  const bounty = await prisma.observedBounty.findFirst({ where: { paymentId: out.paymentId } })
  created.bounties.push(bounty.id)

  const txHash = 'f1'.repeat(32)
  const observed = 1_010_000_000_000n
  // Provisional first (daemon verdict), then the lws sight that claims the
  // block height through the atomic NULL->height CAS.
  await prisma.$transaction(async (tx) => {
    await recordBountyReceipt(tx, bounty, { txHash, piconeros: observed, height: null })
  })
  let claimed
  await prisma.$transaction(async (tx) => {
    claimed = await recordBountyReceipt(tx, bounty, { txHash, piconeros: observed, height: 100 })
  })
  expect(claimed.transitioned).toBe(true)
  expect(claimed.counted).toBe(observed)

  // Replaying the same already-height receipt (lws retry, reconcile re-scan):
  // the CAS matches zero rows — no second transition, no double count.
  let replay
  await prisma.$transaction(async (tx) => {
    replay = await recordBountyReceipt(tx, bounty, { txHash, piconeros: observed, height: 100 })
  })
  expect(replay.transitioned).toBe(false)
  expect(replay.counted).toBe(observed)

  let funded
  await prisma.$transaction(async (tx) => {
    funded = await driveBountyFunding(tx, bounty, { txHash, height: 100, confirmations: 10 })
  })
  expect(funded).toBe(true)
  const afterItem = await prisma.item.findUnique({ where: { id: item.id } })
  expect(afterItem.bountyStatus).toBe('FUNDED')
  // Booked from the COUNTED amount (1.01e12 - 1e10 floor fee), not the display fold.
  expect(afterItem.bountyPiconeros).toBe(1_000_000_000_000n)
  const fee = await prisma.feeObservation.findFirst({ where: { txHash, feeType: 'BOUNTY_FEE' } })
  expect(fee).toMatchObject({ piconeros: 10_000_000_000n, height: 100, state: 'CONFIRMED' })
})

test('a diverging provisional amount is corrected at the height transition and alerts (deduped per bounty+tx)', async () => {
  await ensureFeeConfig()
  const userId = await createUser()
  const item = await createPost(userId)
  await seedEscrow()
  await seedPayer(userId)

  const out = await initiateBountyFundingCore({ postId: item.id, models: prisma, monero: makeMockLws(), me: { id: userId } })
  const bounty = await prisma.observedBounty.findFirst({ where: { paymentId: out.paymentId } })
  created.bounties.push(bounty.id)

  const txHash = 'f3'.repeat(32)
  // The daemon-level callback claims the inflated amount (RingCT unverifiable
  // at that level), then the lws sight proves the real on-chain amount.
  await prisma.$transaction(async (tx) => {
    await recordBountyReceipt(tx, bounty, { txHash, piconeros: 2_000_000_000_000n, height: null })
  })
  let claimed
  await prisma.$transaction(async (tx) => {
    claimed = await recordBountyReceipt(tx, bounty, { txHash, piconeros: 1_000_000_000_000n, height: 100 })
  })
  expect(claimed.transitioned).toBe(true)
  expect(claimed.counted).toBe(1_000_000_000_000n)
  const row = await prisma.observedBountyReceipt.findFirst({ where: { bountyId: bounty.id, txHash } })
  expect(row.piconeros).toBe(1_000_000_000_000n)
  expect(alert).toHaveBeenCalledWith(
    'warn',
    'bounty receipt amount corrected at height transition',
    expect.stringContaining(txHash),
    { dedupeKey: `bounty-receipt-corrected-${bounty.id}-${txHash}` }
  )
})

function fire (body) {
  const res = { status: jest.fn().mockReturnThis(), end: jest.fn() }
  return handleWebhook({ headers: {}, body }, res, prisma, { deleteWebhook: jest.fn() }).then(() => res)
}

test('webhook accumulates bounty receipts across partial payments and funds on the crossing N-conf callback', async () => {
  await ensureFeeConfig()
  const userId = await createUser()
  const item = await createPost(userId)
  await seedEscrow()
  await seedPayer(userId)

  const out = await initiateBountyFundingCore({ postId: item.id, models: prisma, monero: makeMockLws(), me: { id: userId } })
  const bounty = await prisma.observedBounty.findFirst({ where: { paymentId: out.paymentId } })
  created.bounties.push(bounty.id)

  // first partial payment lands (0-conf)
  await fire({ payment_id: out.paymentId, confirmations: 0, tx_info: { tx_hash: 'dd'.repeat(32), block: 100, amount: '600000000000' } })
  let row = await prisma.observedBounty.findUnique({ where: { id: bounty.id } })
  expect(row.state).toBe('DETECTED')
  expect(row.piconeros).toBe(600_000_000_000n)

  // second partial payment (0-conf) — cumulative crosses the 1.01 quote
  await fire({ payment_id: out.paymentId, confirmations: 0, tx_info: { tx_hash: 'de'.repeat(32), block: 101, amount: '410000000000' } })
  row = await prisma.observedBounty.findUnique({ where: { id: bounty.id } })
  expect(row.piconeros).toBe(1_010_000_000_000n)

  // an N-conf callback retry on the FIRST tx is handled idempotently: by now
  // both 0-conf receipts exist and the cumulative total (1.01) already crosses
  // the quote, so the funding fires on this or the callback below — the
  // assertions are order-agnostic
  await fire({ payment_id: out.paymentId, confirmations: 10, tx_info: { tx_hash: 'dd'.repeat(32), block: 100, amount: '600000000000' } })
  // the crossing tx's own N-conf callback (a no-op replay if funded above)
  await fire({ payment_id: out.paymentId, confirmations: 10, tx_info: { tx_hash: 'de'.repeat(32), block: 101, amount: '410000000000' } })

  const afterItem = await prisma.item.findUnique({ where: { id: item.id } })
  expect(afterItem.bountyStatus).toBe('FUNDED')
  expect(afterItem.bountyPiconeros).toBe(1_000_000_000_000n)
  const receipts = await prisma.observedBountyReceipt.findMany({ where: { bountyId: bounty.id } })
  expect(receipts).toHaveLength(2)
})

test('re-entry after a PARTIAL payment quotes the REMAINDER and reports received/expected', async () => {
  await ensureFeeConfig()
  const userId = await createUser()
  const item = await createPost(userId)
  await seedEscrow()
  await seedPayer(userId)
  const monero = makeMockLws()

  const first = await initiateBountyFundingCore({ postId: item.id, models: prisma, monero, me: { id: userId } })
  await fire({ payment_id: first.paymentId, confirmations: 0, tx_info: { tx_hash: 'ee'.repeat(32), block: 100, amount: '600000000000' } })

  const second = await initiateBountyFundingCore({ postId: item.id, models: prisma, monero, me: { id: userId } })

  // same payment id/address (in-flight resume), but the URI now quotes the
  // remainder: 1.01 expected - 0.6 received = 0.41 XMR
  expect(second.paymentId).toBe(first.paymentId)
  expect(second.uri).toContain('tx_amount=0.41')
  expect(second.receivedPiconeros).toBe(600_000_000_000n)
  expect(second.expectedPiconeros).toBe(1_010_000_000_000n)
})
