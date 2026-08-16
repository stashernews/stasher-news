/* eslint-env jest */

// Integration test for the confirmFinalizer job (Task 7 / spec §5.5, Q5).
//
// runConfirmFinalizerOnce is the testable core of the pg-boss confirmFinalizer
// job: it reads the current chain height from monerod (get_info) once per run,
// scans DETECTED ObservedTips whose height is set (mempool tips with height
// null cannot be confirmed yet), and flips the mature ones (confirmations =
// chainHeight - tip.height + 1 >= REQUIRED_CONFIRMATIONS) to CONFIRMED. The
// flip and the author's stackedPiconeros denorm bump run in ONE Prisma
// $transaction so they can never diverge (atomicity is the whole point — a
// DETECTED tip's ranking delta is already applied at detection time; the
// CONFIRMED flip only finalizes the lifetime-received denorm, Q5).
//
// The daemonClient is the only mock — it is the network boundary (DI seam on
// runConfirmFinalizerOnce). Everything else is real DB behaviour against a
// live, migrated database, mirroring test/worker/moneroIndexer.test.js.
//
// Run via the node:22.21.1 helper container:
//   docker exec sn-prisma npx jest test/worker/confirmFinalizer.test.js

import { PrismaClient } from '@prisma/client'
import { runConfirmFinalizerOnce, backfillNullBountyHeights, backfillNullObservationHeights } from '@/worker/confirmFinalizer'
import { bountyFeePiconeros } from '@/api/monero/bounties'

const prisma = new PrismaClient()

const ADDR = '5' + '3'.repeat(94) // 95-char Monero address placeholder

// Tracks every row created across tests so afterAll can tear them down in
// FK-safe order: ObservedTip/ObservedDownvote -> Item -> MoneroAccount -> users.
const created = { users: [], items: [], accounts: [], tips: [], downvotes: [], bounties: [] }

// Pin the fee config deterministically for the height-set-short reconcile
// fixture (same regime as test/worker/bounties.test.js, so the quote math is
// exact: declared 1e12 -> fee 1e10 -> expected 1.01e12); restore in afterAll.
const FEE_CONFIG = { bountyFeeMinPiconeros: 10_000_000_000n, bountyFeePct: 1 }
let feeConfigSnapshot = null

afterAll(async () => {
  await prisma.observedTip.deleteMany({ where: { id: { in: created.tips } } })
  await prisma.observedDownvote.deleteMany({ where: { id: { in: created.downvotes } } })
  // ObservedBountyReceipt rows cascade on ObservedBounty delete (FK onDelete: Cascade).
  await prisma.observedBounty.deleteMany({ where: { id: { in: created.bounties } } })
  await prisma.feeObservation.deleteMany({ where: { postId: { in: created.items }, feeType: 'BOUNTY_FEE' } })
  for (const id of created.items) {
    await prisma.itemUserAgg.deleteMany({ where: { itemId: id } })
    await prisma.item.deleteMany({ where: { id } })
  }
  // MoneroViewKey must go before MoneroAccount (FK: accountId -> account.id).
  await prisma.moneroViewKey.deleteMany({ where: { accountId: { in: created.accounts } } })
  // ObservedTip must go before MoneroAccount (FK: recipientAccountId -> account.id, RESTRICT)
  for (const id of created.accounts) await prisma.moneroAccount.deleteMany({ where: { id } })
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } })
  // Restore the live dev config row if a test pinned it deterministically.
  if (feeConfigSnapshot) {
    await prisma.platformFeeConfig.update({ where: { id: 1 }, data: feeConfigSnapshot })
    feeConfigSnapshot = null
  }
  await prisma.$disconnect()
})

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  return rows[0].id
}

// Root post: path is the item's own id as a single ltree label (SN convention).
async function createRoot (userId, title) {
  const rows = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", title) VALUES (${userId}::int, ${title})
    RETURNING id::int AS id`
  const id = rows[0].id
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(id)}::ltree WHERE id = ${id}::int`
  return id
}

// A minimal MoneroAccount to satisfy the ObservedTip.recipientAccountId FK.
// confirmFinalizer never touches the view key, so none is seeded here.
let accountSeq = 0
async function seedAccount () {
  accountSeq += 1
  const account = await prisma.moneroAccount.create({
    data: {
      ownerUserId: null,
      address: ADDR + String(accountSeq), // unique per ([address, network])
      label: 'test',
      network: 'STAGENET',
      status: 'ACTIVE'
    }
  })
  created.accounts.push(account.id)
  return account
}

// An account carrying a (dummy) view key, so the finalizer's lws backfill path
// treats it as scannable. The lwsClient is mocked in those tests, so the dummy
// envelope is never actually decrypted — it just needs to be truthy.
let viewAccountSeq = 1000
async function seedAccountWithViewKey () {
  viewAccountSeq += 1
  const account = await prisma.moneroAccount.create({
    data: {
      ownerUserId: null,
      address: ADDR + 'vk' + String(viewAccountSeq),
      label: 'test',
      network: 'STAGENET',
      status: 'ACTIVE'
    }
  })
  created.accounts.push(account.id)
  await prisma.moneroViewKey.create({
    data: {
      accountId: account.id,
      ciphertext: Buffer.alloc(1),
      iv: Buffer.alloc(12),
      tag: Buffer.alloc(16),
      wrappedDek: Buffer.alloc(1),
      dekVersion: 0
    }
  })
  return account
}

// A mock lwsClient whose getAddressTxs reports no txs — keeps the live-DB runs
// hermetic (no real lws call, no accidental funding of unrelated dev-DB bounties
// such as the stuck item 2808, whose NULL-height row would otherwise be picked
// up by the backfill scan).
function emptyLws () {
  return { getAddressTxs: jest.fn().mockResolvedValue({ transactions: [], blockchain_height: 0 }) }
}

// Seed a DETECTED ObservedTip directly (bypassing the indexer) so the test
// exercises ONLY the confirmFinalizer flip path. txHash must be unique under
// the @@unique([txHash, recipientAccountId, recipientMajor, recipientMinor]).
let tipSeq = 0
async function seedTip ({ postId, piconeros, height, recipientAccountId }) {
  tipSeq += 1
  const tip = await prisma.observedTip.create({
    data: {
      txHash: 'cf' + String(tipSeq),
      postId,
      tipperId: null,
      recipientAccountId,
      recipientMajor: 0,
      recipientMinor: 0,
      paymentId: 'cftest' + String(tipSeq).padStart(8, '0') + '00000000',
      piconeros,
      height,
      state: 'DETECTED',
      proofType: 'INDEXED'
    }
  })
  created.tips.push(tip.id)
  return tip
}

// The daemonClient DI mock: only getHeight is consulted per run.
function mockClient (height) {
  return { getHeight: jest.fn().mockResolvedValue(height) }
}

function readTip (id) {
  return prisma.observedTip.findUnique({ where: { id } })
}

function readUser (id) {
  return prisma.user.findUnique({ where: { id }, select: { stackedPiconeros: true } })
}

// Seed a DETECTED ObservedDownvote directly (bypassing the indexer) so the test
// exercises ONLY the confirmFinalizer flip path. txHash/paymentId must be
// unique under the @@unique([txHash, paymentId]).
let downvoteSeq = 0
async function seedDownvote ({ postId, piconeros, height }) {
  downvoteSeq += 1
  const downvote = await prisma.observedDownvote.create({
    data: {
      txHash: 'odv' + String(downvoteSeq),
      postId,
      downvoterId: null,
      paymentId: 'odvtest' + String(downvoteSeq).padStart(8, '0') + '00000000',
      piconeros,
      height,
      state: 'DETECTED'
    }
  })
  created.downvotes.push(downvote.id)
  return downvote
}

test('a DETECTED tip at height 200 becomes CONFIRMED at chain height 209 (10 confs) and bumps the author denorm atomically', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createRoot(authorId, 'confirm-target'); created.items.push(postId)
  const account = await seedAccount()
  const tip = await seedTip({ postId, piconeros: 5_000_000n, height: 200, recipientAccountId: account.id })

  expect((await readUser(authorId)).stackedPiconeros).toBe(0n)

  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(209), lwsClient: emptyLws() })

  const after = await readTip(tip.id)
  expect(after.state).toBe('CONFIRMED')
  expect(after.confirmations).toBe(10)
  expect(after.confirmedAt).toBeInstanceOf(Date)
  expect((await readUser(authorId)).stackedPiconeros).toBe(5_000_000n)
})

test('a DETECTED tip stays DETECTED at 9 confirmations (chain 208) and does not bump the author', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createRoot(authorId, 'not-yet'); created.items.push(postId)
  const account = await seedAccount()
  const tip = await seedTip({ postId, piconeros: 5_000_000n, height: 200, recipientAccountId: account.id })

  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(208), lwsClient: emptyLws() })

  const after = await readTip(tip.id)
  expect(after.state).toBe('DETECTED')
  expect(after.confirmedAt).toBeNull()
  expect((await readUser(authorId)).stackedPiconeros).toBe(0n)
})

test('a mempool tip (height null) is skipped even at high chain height', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createRoot(authorId, 'mempool'); created.items.push(postId)
  const account = await seedAccount()
  const tip = await seedTip({ postId, piconeros: 5_000_000n, height: null, recipientAccountId: account.id })

  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(9999), lwsClient: emptyLws() })

  const after = await readTip(tip.id)
  expect(after.state).toBe('DETECTED')
  expect((await readUser(authorId)).stackedPiconeros).toBe(0n)
})

test('idempotent: running twice does not double-bump the author denorm', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createRoot(authorId, 'idempotent'); created.items.push(postId)
  const account = await seedAccount()
  const tip = await seedTip({ postId, piconeros: 7_000_000n, height: 200, recipientAccountId: account.id })

  const client = mockClient(209)
  await runConfirmFinalizerOnce({ models: prisma, daemonClient: client, lwsClient: emptyLws() })
  await runConfirmFinalizerOnce({ models: prisma, daemonClient: client, lwsClient: emptyLws() })

  const after = await readTip(tip.id)
  expect(after.state).toBe('CONFIRMED')
  expect((await readUser(authorId)).stackedPiconeros).toBe(7_000_000n)
})

test('a DETECTED ObservedDownvote becomes CONFIRMED at 10 confirmations', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createRoot(authorId, 'downvote-confirm-target'); created.items.push(postId)
  const downvote = await seedDownvote({ postId, piconeros: 1_000_000_000n, height: 500 })

  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(509), lwsClient: emptyLws() })

  const after = await prisma.observedDownvote.findUnique({ where: { id: downvote.id } })
  expect(after.state).toBe('CONFIRMED')
  expect(after.confirmations).toBe(10)
  expect(after.confirmedAt).toBeInstanceOf(Date)
})

test('a DETECTED ObservedDownvote stays DETECTED below 10 confirmations', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createRoot(authorId, 'downvote-not-yet'); created.items.push(postId)
  const downvote = await seedDownvote({ postId, piconeros: 1_000_000_000n, height: 500 })

  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(508), lwsClient: emptyLws() })

  const after = await prisma.observedDownvote.findUnique({ where: { id: downvote.id } })
  expect(after.state).toBe('DETECTED')
  expect(after.confirmedAt).toBeNull()
})

// Seed a DETECTED ObservedBounty directly (bypassing the webhook) so the test
// exercises ONLY the confirmFinalizer flip path. txHash/paymentId must be
// unique under the @@unique([txHash, paymentId]).
let bountySeq = 0
async function seedBounty ({ postId, piconeros, height, recipientAccountId }) {
  bountySeq += 1
  const bounty = await prisma.observedBounty.create({
    data: {
      txHash: 'obv' + String(bountySeq),
      postId,
      payerId: null,
      recipientAccountId,
      paymentId: 'obtest' + String(bountySeq).padStart(8, '0') + '00000000',
      piconeros,
      height,
      state: 'DETECTED'
    }
  })
  created.bounties.push(bounty.id)
  return bounty
}

// A bounty post with a DECLARED bounty amount — real fundings always carry one
// (the raw createRoot default of 0 would book a zero fee under the
// declared-amount fee rule). The funding-path fixtures pay the full declared +
// fee quote (the confirmation gate holds anything short), so the fee math
// stays exact and readable.
async function createBountyRoot (userId, title, bountyPiconeros) {
  const postId = await createRoot(userId, title)
  await prisma.item.update({
    where: { id: postId },
    data: { bountyPiconeros }
  })
  created.items.push(postId)
  return postId
}

test('a DETECTED ObservedBounty becomes CONFIRMED at 10 confirmations AND runs driveBountyFunding (Item FUNDED + BOUNTY_FEE booked) — true backstop for a missed webhook CONFIRMED callback', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createBountyRoot(authorId, 'bounty-confirm-target', 5_000_000_000n)
  const account = await seedAccount()
  // The confirmation gate requires cumulative received >= declared + fee, so
  // the fixture pays the FULL quote (5e9 declared + fee; fee on the declared
  // 5e9 is cap-bound at 1e9 with the dev config's 0.01 floor).
  const config = await prisma.platformFeeConfig.findUnique({ where: { id: 1 } })
  const feePiconeros = bountyFeePiconeros(5_000_000_000n, config)
  const bounty = await seedBounty({ postId, piconeros: 5_000_000_000n + feePiconeros, height: 700, recipientAccountId: account.id })

  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(709), lwsClient: emptyLws() })

  const after = await prisma.observedBounty.findUnique({ where: { id: bounty.id } })
  expect(after.state).toBe('CONFIRMED')
  expect(after.confirmations).toBe(10)
  expect(after.confirmedAt).toBeInstanceOf(Date)

  // The finalizer is the BACKSTOP for a missed webhook CONFIRMED callback, so it
  // must run the same ledger effects as driveBountyFunding — not just flip the
  // row. Item -> FUNDED with bountyPiconeros = observed − fee (fee booked from
  // the DECLARED bounty; observed = declared + fee here, so 6e9 → 5e9 booked).
  const item = await prisma.item.findUnique({ where: { id: postId } })
  expect(item.bountyStatus).toBe('FUNDED')
  expect(item.bountyPiconeros).toBe(5_000_000_000n)
  expect(item.bountyConfirmedAt).toBeInstanceOf(Date)
  const fee = await prisma.feeObservation.findFirst({ where: { postId, feeType: 'BOUNTY_FEE' } })
  expect(fee).toMatchObject({ piconeros: feePiconeros, state: 'CONFIRMED', height: 700 })
})

test('a DETECTED ObservedBounty stays DETECTED below 10 confirmations', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createBountyRoot(authorId, 'bounty-not-yet', 5_000_000_000n)
  const account = await seedAccount()
  const bounty = await seedBounty({ postId, piconeros: 5_000_000_000n, height: 700, recipientAccountId: account.id })

  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(708), lwsClient: emptyLws() })

  const after = await prisma.observedBounty.findUnique({ where: { id: bounty.id } })
  expect(after.state).toBe('DETECTED')
  expect(after.confirmedAt).toBeNull()
  // No funding side effects below the threshold.
  const item = await prisma.item.findUnique({ where: { id: postId } })
  expect(item.bountyStatus).toBe('UNFUNDED')
  const fee = await prisma.feeObservation.findFirst({ where: { postId, feeType: 'BOUNTY_FEE' } })
  expect(fee).toBeNull()
})

test('a NULL-height DETECTED bounty (webhook CONFIRMED callback missed at 0-conf) is resolved via lws and funded at N confirmations — item 2808 scenario', async () => {
  // The 0-conf webhook consumed the pid map and set height = NULL (mempool tx).
  // After the gate bug, every later callback was a 200 no-op, so no callback ever
  // backfilled height. The finalizer must resolve the tx height from lws (which
  // watches the escrow account), record the receipt (cumulative received), then
  // fund it once the total covers declared + fee.
  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createBountyRoot(authorId, 'bounty-null-height', 5_000_000_000n)
  const account = await seedAccountWithViewKey()
  const bounty = await seedBounty({ postId, piconeros: 5_000_000_000n, height: null, recipientAccountId: account.id })
  const config = await prisma.platformFeeConfig.findUnique({ where: { id: 1 } })
  const feePiconeros = bountyFeePiconeros(5_000_000_000n, config)

  // Mock lws reports the funding tx (matched by payment_id) now at height 700,
  // paying the full declared + fee quote.
  const lws = {
    getAddressTxs: jest.fn().mockResolvedValue({
      transactions: [{ payment_id: bounty.paymentId, hash: 'e2'.repeat(32), height: 700, piconeros: 5_000_000_000n + feePiconeros }],
      blockchain_height: 709
    })
  }
  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(709), lwsClient: lws })
  // lws was scanned for the test bounty's escrow account. (It is also scanned
  // for any other NULL-height bounty in the live dev DB — e.g. the real item
  // 2808, which this same code path self-heals in production.)
  const scannedIds = lws.getAddressTxs.mock.calls.map(c => c[0].id)
  expect(scannedIds).toContain(account.id)

  // Height backfilled, then funded through the normal path.
  const after = await prisma.observedBounty.findUnique({ where: { id: bounty.id } })
  expect(after.state).toBe('CONFIRMED')
  expect(after.height).toBe(700)
  expect(after.confirmations).toBe(10)
  const item = await prisma.item.findUnique({ where: { id: postId } })
  expect(item.bountyStatus).toBe('FUNDED')
  const fee = await prisma.feeObservation.findFirst({ where: { postId, feeType: 'BOUNTY_FEE' } })
  expect(fee).not.toBeNull()
  expect(fee.state).toBe('CONFIRMED')
})

test('a NULL-height DETECTED bounty whose tx is still in mempool (lws reports height null) is left DETECTED, not funded', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createBountyRoot(authorId, 'bounty-mempool-null', 5_000_000_000n)
  const account = await seedAccountWithViewKey()
  const bounty = await seedBounty({ postId, piconeros: 5_000_000_000n, height: null, recipientAccountId: account.id })

  // lws still sees the tx in the mempool (height null) — nothing to backfill.
  const lws = {
    getAddressTxs: jest.fn().mockResolvedValue({
      transactions: [{ payment_id: bounty.paymentId, height: null, piconeros: 5_000_000_000n }],
      blockchain_height: 9999
    })
  }
  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(9999), lwsClient: lws })

  const after = await prisma.observedBounty.findUnique({ where: { id: bounty.id } })
  expect(after.state).toBe('DETECTED')
  expect(after.height).toBeNull()
  const item = await prisma.item.findUnique({ where: { id: postId } })
  expect(item.bountyStatus).toBe('UNFUNDED')
})

// Underpayment support: a funding paid in TWO txs whose webhook callbacks were
// all lost. The lws scan reports both txs carrying the bounty's payment id, so
// EVERY matching tx becomes a receipt (idempotent by txHash) and
// ObservedBounty.piconeros folds to the cumulative sum — recovering top-ups a
// single-tx resolver would have missed.
test('backfillNullBountyHeights records EVERY matching lws tx as a receipt: top-ups accumulate and height backfills to the max', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createBountyRoot(authorId, 'bounty-receipt-backfill', 1_000_000_000_000n)
  const account = await seedAccountWithViewKey()
  const bounty = await seedBounty({ postId, piconeros: 0n, height: null, recipientAccountId: account.id })

  // Two partial payments (0.6 + 0.41 on a 1.0-declared bounty): cumulative
  // 1.01 = declared + fee, at heights 100 and 101.
  const lws = {
    getAddressTxs: async () => ({
      transactions: [
        { payment_id: bounty.paymentId, hash: 'ba'.repeat(31) + '1', height: 100, piconeros: 600_000_000_000n },
        { payment_id: bounty.paymentId, hash: 'ba'.repeat(31) + '2', height: 101, piconeros: 410_000_000_000n }
      ],
      blockchain_height: 150
    })
  }
  await backfillNullBountyHeights({ models: prisma, lws, bounties: [bounty] })

  const receipts = await prisma.observedBountyReceipt.findMany({ where: { bountyId: bounty.id } })
  expect(receipts).toHaveLength(2)
  const after = await prisma.observedBounty.findUnique({ where: { id: bounty.id } })
  expect(after.piconeros).toBe(1_010_000_000_000n)
  expect(after.height).toBe(101)
})

// Fix-wave regression: a HEIGHT-SET but still-short DETECTED bounty. The first
// payment's 1-conf callback set the height (100), but the top-up's callbacks
// were ALL lost — and nothing else records it (the observer watches only the
// rewards wallet; reconcilePendingTips is tips-only). The reconcile pass must
// fold receipts for short DETECTED bounties REGARDLESS of height, or the gate
// never opens and the 7-day sweep abandons with refund < actually sent,
// silently (the payment predates the abandonment, so no alert fires either).
test('a HEIGHT-set short DETECTED bounty is reconciled too: both txs folded, height to max, idempotent', async () => {
  const before = await prisma.platformFeeConfig.findUnique({ where: { id: 1 } })
  feeConfigSnapshot = { bountyFeeMinPiconeros: before.bountyFeeMinPiconeros, bountyFeePct: before.bountyFeePct }
  await prisma.platformFeeConfig.update({ where: { id: 1 }, data: FEE_CONFIG })

  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createBountyRoot(authorId, 'bounty-height-set-short', 1_000_000_000_000n)
  const account = await seedAccountWithViewKey()
  // 0.6 of the 1.01 quote received so far; height 100 came from the first
  // payment's own callback. lws still reports BOTH txs (0.6 at 100, 0.41 at 101).
  const bounty = await seedBounty({ postId, piconeros: 600_000_000_000n, height: 100, recipientAccountId: account.id })

  const lws = () => ({
    getAddressTxs: async () => ({
      transactions: [
        { payment_id: bounty.paymentId, hash: 'hs'.repeat(31) + '1', height: 100, piconeros: 600_000_000_000n },
        { payment_id: bounty.paymentId, hash: 'hs'.repeat(31) + '2', height: 101, piconeros: 410_000_000_000n }
      ],
      blockchain_height: 150
    })
  })
  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(150), lwsClient: lws() })

  let receipts = await prisma.observedBountyReceipt.findMany({ where: { bountyId: bounty.id } })
  expect(receipts).toHaveLength(2)
  let after = await prisma.observedBounty.findUnique({ where: { id: bounty.id } })
  expect(after.piconeros).toBe(1_010_000_000_000n)
  expect(after.height).toBe(101)

  // idempotent: a second pass records no duplicate rows and does not throw
  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(150), lwsClient: lws() })
  receipts = await prisma.observedBountyReceipt.findMany({ where: { bountyId: bounty.id } })
  expect(receipts).toHaveLength(2)
  after = await prisma.observedBounty.findUnique({ where: { id: bounty.id } })
  expect(after.piconeros).toBe(1_010_000_000_000n)
  expect(after.height).toBe(101)
})

test('invokes the reorg detector with the current chain height (Task D5 wiring)', async () => {
  const detectReorg = jest.fn()
  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(210), detectReorg, lwsClient: emptyLws() })
  expect(detectReorg).toHaveBeenCalledWith(210)
})

// backfillNullBountyHeights: mocked-models unit tests for the lws height
// resolution (the path that unsticks a NULL-height bounty whose N-conf webhook
// callback was missed). Mirrors the reconcilePendingTips test style.
describe('backfillNullBountyHeights', () => {
  test('resolves a NULL-height bounty tx via lws (matched by payment_id) and backfills the row height', async () => {
    const bounty = { id: 1n, paymentId: 'bnabc', recipientAccountId: 7, height: null }
    const account = { id: 7, address: 'ESCROW', status: 'ACTIVE', viewKey: { ciphertext: Buffer.alloc(0) } }
    const models = {
      moneroAccount: { findMany: async () => [account] },
      observedBounty: { update: jest.fn() }
    }
    const lws = { getAddressTxs: async () => ({ transactions: [{ payment_id: 'BNABC', height: 12345 }], blockchain_height: 9999 }) }
    await backfillNullBountyHeights({ models, lws, bounties: [bounty] })
    expect(models.observedBounty.update).toHaveBeenCalledWith({
      where: { id: 1n },
      data: expect.objectContaining({ height: 12345 })
    })
  })

  test('skips an account with no view key (unscannable) and never calls lws', async () => {
    const bounty = { id: 2n, paymentId: 'bndef', recipientAccountId: 8, height: null }
    const account = { id: 8, address: 'ESCROW', status: 'ACTIVE', viewKey: null }
    const models = { moneroAccount: { findMany: async () => [account] }, observedBounty: { update: jest.fn() } }
    const lws = { getAddressTxs: jest.fn() }
    await backfillNullBountyHeights({ models, lws, bounties: [bounty] })
    expect(lws.getAddressTxs).not.toHaveBeenCalled()
    expect(models.observedBounty.update).not.toHaveBeenCalled()
  })

  test('is robust to an lws error (skips that account, does not throw, retries next run)', async () => {
    const bounty = { id: 3n, paymentId: 'bnerr', recipientAccountId: 9, height: null }
    const account = { id: 9, address: 'ESCROW', status: 'ACTIVE', viewKey: { ciphertext: Buffer.alloc(0) } }
    const models = { moneroAccount: { findMany: async () => [account] }, observedBounty: { update: jest.fn() } }
    const lws = { getAddressTxs: jest.fn().mockRejectedValue(new Error('lws down')) }
    await expect(backfillNullBountyHeights({ models, lws, bounties: [bounty] })).resolves.toBeUndefined()
    expect(models.observedBounty.update).not.toHaveBeenCalled()
  })

  test('does not backfill when lws has no matching payment_id (foreign/unknown tx)', async () => {
    const bounty = { id: 4n, paymentId: 'bnnope', recipientAccountId: 10, height: null }
    const account = { id: 10, address: 'ESCROW', status: 'ACTIVE', viewKey: { ciphertext: Buffer.alloc(0) } }
    const models = { moneroAccount: { findMany: async () => [account] }, observedBounty: { update: jest.fn() } }
    const lws = { getAddressTxs: async () => ({ transactions: [{ payment_id: 'other', height: 999 }], blockchain_height: 9999 }) }
    await backfillNullBountyHeights({ models, lws, bounties: [bounty] })
    expect(models.observedBounty.update).not.toHaveBeenCalled()
  })
})

// backfillNullObservationHeights: mocked-models unit tests for the NULL-height
// backfill of poll-detected DETECTED rows (ObservedDownvote, FeeObservation).
// NOTE: the plan's snippets mocked moneroAccount.findMany (mirroring
// backfillNullBountyHeights), but this backfill resolves the account via
// findRewardsAccount, which queries moneroAccount.findFirst — the mocks here
// match the actual interface. Everything else is verbatim from the plan.
describe('backfillNullObservationHeights', () => {
  test('backfills NULL heights for DETECTED downvotes and fees from the lws rewards scan, keyed by txHash', async () => {
    const downvote = { id: 1n, txHash: 'aaa', postId: 572, state: 'DETECTED', height: null }
    const fee = { id: 2n, txHash: 'bbb', feeType: 'POSTING', state: 'DETECTED', height: null }
    const account = { id: 2047, label: 'platform_rewards', status: 'ACTIVE', viewKey: { ciphertext: 'x' } }
    const models = {
      moneroAccount: { findFirst: jest.fn().mockResolvedValue(account) },
      observedDownvote: { update: jest.fn().mockResolvedValue({}) },
      feeObservation: { update: jest.fn().mockResolvedValue({}) }
    }
    const lws = {
      getAddressTxs: jest.fn().mockResolvedValue({
        transactions: [
          { hash: 'aaa', height: 2186635, confirmations: 12, payment_id: 'bb82f32561ab78d1' },
          { hash: 'bbb', height: null }, // still mempool on lws — must stay NULL
          { hash: 'ccc', height: 2186640 } // unrelated tx — no row to update
        ]
      })
    }

    await backfillNullObservationHeights({ models, lws, downvotes: [downvote], fees: [fee] })

    expect(models.observedDownvote.update).toHaveBeenCalledWith({
      where: { id: 1n },
      data: { height: 2186635, confirmations: 12 }
    })
    expect(models.feeObservation.update).not.toHaveBeenCalled() // bbb still mempool
  })

  test('skips unscannable accounts (no view key) without throwing', async () => {
    const models = {
      moneroAccount: { findFirst: jest.fn().mockResolvedValue({ id: 2047, status: 'ACTIVE', viewKey: null }) },
      observedDownvote: { update: jest.fn() },
      feeObservation: { update: jest.fn() }
    }
    const lws = { getAddressTxs: jest.fn() }

    await expect(backfillNullObservationHeights({ models, lws, downvotes: [{ id: 1n, txHash: 'aaa' }], fees: [] })).resolves.toBeUndefined()
    expect(lws.getAddressTxs).not.toHaveBeenCalled()
  })
})
