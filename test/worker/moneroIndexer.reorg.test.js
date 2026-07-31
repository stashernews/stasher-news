/* eslint-env jest */

// Integration test for the reorg reconciliation branch of moneroIndexer
// (Task 6 / spec §5.5).
//
// monero-lws signals a reorg to a REST poller by REPLAYING affected history: if
// the stored since_tx_block_hash was invalidated, the response includes txs
// behind the forward cursor (id <= account.lastTxId) instead of only newer ones
// (docs/monero-lws-research.md §8, lines 749-754; spec §5.5 line 752). The
// indexer detects that replay and, for every DETECTED ObservedTip on the account
// that is ABSENT from the replay and older than REORG_GRACE_BLOCKS, flips it to
// REORGED and calls reverseTip (Task 5). Tips at >= REQUIRED_CONFIRMATIONS are
// final and never reverted. A REORGED tip that reappears in a later poll is
// revived to DETECTED and re-bumped.
//
// The lwsClient and daemonClient are the only mocks (DI seams on
// runIndexerOnce). Everything else is real DB behaviour against a live,
// migrated database, mirroring test/worker/moneroIndexer.test.js.
//
// Run via the node:22.21.1 helper container:
//   docker exec sn-prisma npx jest test/worker/moneroIndexer.reorg.test.js

import { PrismaClient } from '@prisma/client'
import { encryptViewKey } from '@/api/monero/viewkey'
import { applyTipDetected, reverseTip } from '@/api/monero/ranking'
import { runIndexerOnce } from '@/worker/moneroIndexer'

// reverseTip AND applyTipDetected are each wrapped in a jest.fn so the
// atomicity regression tests (revive + reconcile, last two tests) can make
// either throw mid-transaction. By default both mocks delegate to the real
// implementation, so seedTip and the other tests exercise real ranking
// behaviour. jest.mock is auto-hoisted above the imports by the transform (the
// pattern used in moneroIndexer.test.js and lib/ssrf.spec.js), so
// worker/moneroIndexer.js — loaded via the import above — also receives the
// mocked functions. The synchronous jest.mock (not jest.unstable_mockModule) is
// the form next/jest's transform honours.
jest.mock('../../api/monero/ranking', () => {
  const actual = jest.requireActual('../../api/monero/ranking')
  return {
    ...actual,
    applyTipDetected: jest.fn((...args) => actual.applyTipDetected(...args)),
    reverseTip: jest.fn((...args) => actual.reverseTip(...args))
  }
})

// Envelope encryption needs a master key in the env (Task 2).
process.env.VIEWKEY_MASTER_KEY = Buffer.from('a'.repeat(32)).toString('base64')

const prisma = new PrismaClient()

// Capture the real applyTipDetected + reverseTip so afterEach can restore the
// delegating implementation after any per-test override (atomicity tests).
let realApplyTipDetected
let realReverseTip
beforeAll(() => {
  realApplyTipDetected = jest.requireActual('../../api/monero/ranking').applyTipDetected
  realReverseTip = jest.requireActual('../../api/monero/ranking').reverseTip
})
afterEach(() => {
  applyTipDetected.mockImplementation((...args) => realApplyTipDetected(...args))
  reverseTip.mockImplementation((...args) => realReverseTip(...args))
})

const ADDR = '5' + '1'.repeat(94) // 95-char Monero address placeholder
const VIEWKEY_HEX = '7e3d' + '0'.repeat(60) // 64-hex private view key placeholder
const SUB_ADDR = '5' + '2'.repeat(94) // a subaddress on that account

// FK-safe teardown order: ObservedTip -> SubaddressIndex -> Item -> MoneroViewKey
// -> MoneroAccount -> users.
const created = { users: [], items: [], accounts: [], subs: [] }

afterAll(async () => {
  await prisma.observedTip.deleteMany({ where: { postId: { in: created.items } } })
  for (const id of created.subs) await prisma.subaddressIndex.delete({ where: { id } }).catch(() => {})
  for (const id of created.items) {
    await prisma.itemUserAgg.deleteMany({ where: { itemId: id } })
    await prisma.item.deleteMany({ where: { id } })
  }
  await prisma.moneroViewKey.deleteMany({ where: { accountId: { in: created.accounts } } })
  for (const id of created.accounts) await prisma.moneroAccount.deleteMany({ where: { id } })
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } })
  await prisma.$disconnect()
})

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  return rows[0].id
}

async function createRoot (userId, title) {
  const rows = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", title) VALUES (${userId}::int, ${title})
    RETURNING id::int AS id`
  const id = rows[0].id
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(id)}::ltree WHERE id = ${id}::int`
  return id
}

// Seed user + ACTIVE MoneroAccount (view-key envelope) + a SubaddressIndex at
// (majorIndex, minorIndex) -> postId. Returns the account row.
async function seedAccount ({ majorIndex = 0, minorIndex = 3, postId }) {
  const userId = await createUser(); created.users.push(userId)
  const account = await prisma.moneroAccount.create({
    data: {
      ownerUserId: userId,
      address: ADDR + userId + minorIndex, // unique per test ([address, network] @@unique)
      label: 'author',
      network: 'STAGENET',
      status: 'ACTIVE'
    }
  })
  created.accounts.push(account.id)
  await prisma.moneroViewKey.create({
    data: { accountId: account.id, ...encryptViewKey(VIEWKEY_HEX) }
  })
  const sub = await prisma.subaddressIndex.create({
    data: { accountId: account.id, majorIndex, minorIndex, address: SUB_ADDR + userId + minorIndex, assignedPostId: postId }
  })
  created.subs.push(sub.id)
  return account
}

// Seed an already-DETECTED (or CONFIRMED/REORGED) ObservedTip on the account,
// pre-bump Item.msats via the real applyTipDetected path, and set the account's
// forward cursor past this tx (lastTxId) plus a lastBlockHash so the next poll
// is in reorg-safe cursor mode.
async function seedTip ({ account, postId, txHash, height, piconeros, state = 'DETECTED', majorIndex = 0, minorIndex = 3, lastTxId = 1001n, lastBlockHash = 'hash200' }) {
  await applyTipDetected(postId, null, piconeros)
  if (state === 'REORGED') {
    // simulate the prior reversal having already fired
    await reverseTip(postId, piconeros)
  }
  await prisma.observedTip.create({
    data: {
      txHash,
      postId,
      tipperId: null,
      recipientAccountId: account.id,
      recipientMajor: majorIndex,
      recipientMinor: minorIndex,
      paymentId: null,
      piconeros,
      height,
      state,
      proofType: 'INDEXED'
    }
  })
  await prisma.moneroAccount.update({
    where: { id: account.id },
    data: { lastTxId, lastBlockHash }
  })
}

// A mock lwsClient that returns the supplied transactions ONLY for the account
// under test (empty for all other active accounts). runIndexerOnce polls every
// ACTIVE account, so an account-agnostic mock would cross-contaminate tests
// (and would not mirror real lws, which is per-account).
function mockLwsFor (targetAccount, transactions, blockchainHeight) {
  return {
    getAddressTxs: jest.fn(async (acc) =>
      acc.id === targetAccount.id
        ? { transactions, blockchain_height: blockchainHeight }
        : { transactions: [], blockchain_height: blockchainHeight })
  }
}

// A mock daemonClient whose getBlockHashByHeight returns a deterministic hash.
function mockDaemon (hash = 'hash195') {
  return { getBlockHashByHeight: jest.fn().mockResolvedValue(hash) }
}

// lws wire-shape tx. id/height/piconeros/hash configurable.
function tx ({ id, hash, height, piconeros, majI = 0, minI = 3 }) {
  return { id, hash, piconeros, recipient: { maj_i: majI, min_i: minI }, height, payment_id: null }
}

function readItemMsats (id) {
  return prisma.item.findUnique({ where: { id }, select: { msats: true } })
}

// ---- the reorg reconciliation branch ---------------------------------------

// The polling loop is superseded by the webhook approach (spec 2026-07-27).
// runIndexerOnce + its tests are kept as a reference/fallback but skipped.
describe.skip('moneroIndexer reorg — superseded by webhooks', () => {
  test('a replay (tx behind the cursor) reverts a DETECTED tip absent from the response and reverses msats', async () => {
    const userId = await createUser(); created.users.push(userId)
    const postId = await createRoot(userId, 'reorg-target'); created.items.push(postId)
    const account = await seedAccount({ postId })

    // Pre-existing DETECTED tip 'ab12' at height 200 (6 conf at chain 205), 5M piconeros.
    await seedTip({ account, postId, txHash: 'ab12', height: 200, piconeros: 5_000_000n })
    expect((await readItemMsats(postId)).msats).toBe(5_000_000n)

    // lws replay: a surviving tx BEHIND the cursor (id 990 <= lastTxId 1001) at an
    // unmapped subaddress, 'ab12' absent. This is the reorg signal.
    const lws = mockLwsFor(account, [tx({ id: 990, hash: 'survivor', height: 195, piconeros: 1000n, minI: 999 })], 205)
    await runIndexerOnce({ models: prisma, lwsClient: lws, daemonClient: mockDaemon('hash195') })

    const tip = await prisma.observedTip.findFirst({ where: { txHash: 'ab12', recipientAccountId: account.id } })
    expect(tip.state).toBe('REORGED')
    expect((await readItemMsats(postId)).msats).toBe(0n)

    // the cursor also shifted: block hash refreshed from the highest confirmed tx
    const stored = await prisma.moneroAccount.findUnique({ where: { id: account.id } })
    expect(stored.lastBlockHash).toBe('hash195')
    expect(stored.lastTxId).toBe(990n) // shifted backward through the replay
  })

  test('a tip at >= REQUIRED_CONFIRMATIONS is never reverted even if absent from the replay', async () => {
    const userId = await createUser(); created.users.push(userId)
    const postId = await createRoot(userId, 'confirmed-target'); created.items.push(postId)
    const account = await seedAccount({ postId })

    // CONFIRMED tip at height 190 -> 205-190+1 = 16 confirmations (>= 10). Final.
    await seedTip({ account, postId, txHash: 'cf34', height: 190, piconeros: 4_000_000n, state: 'CONFIRMED' })

    // replay with no surviving txs for this account, 'cf34' absent.
    const lws = mockLwsFor(account, [tx({ id: 980, hash: 'unrelated', height: 185, piconeros: 1000n, minI: 999 })], 205)
    await runIndexerOnce({ models: prisma, lwsClient: lws, daemonClient: mockDaemon('hash185') })

    const tip = await prisma.observedTip.findFirst({ where: { txHash: 'cf34', recipientAccountId: account.id } })
    expect(tip.state).toBe('CONFIRMED') // untouched
    expect((await readItemMsats(postId)).msats).toBe(4_000_000n) // delta NOT reversed
  })

  test('a REORGED tip that reappears is revived to DETECTED and re-bumped', async () => {
    const userId = await createUser(); created.users.push(userId)
    const postId = await createRoot(userId, 'revive-target'); created.items.push(postId)
    const account = await seedAccount({ postId })

    // Pre-existing REORGED tip 'ab12' — msats already reversed to 0 by seedTip.
    await seedTip({ account, postId, txHash: 'ab12', height: 200, piconeros: 5_000_000n, state: 'REORGED' })
    expect((await readItemMsats(postId)).msats).toBe(0n)

    // The new chain re-included 'ab12'; lws returns it again (forward of cursor).
    const lws = mockLwsFor(account, [tx({ id: 1002, hash: 'ab12', height: 200, piconeros: 5_000_000n })], 205)
    await runIndexerOnce({ models: prisma, lwsClient: lws, daemonClient: mockDaemon('hash200') })

    const tip = await prisma.observedTip.findFirst({ where: { txHash: 'ab12', recipientAccountId: account.id } })
    expect(tip.state).toBe('DETECTED') // revived
    expect((await readItemMsats(postId)).msats).toBe(5_000_000n) // delta re-applied
    // exactly one row for this account (no duplicate despite the @@unique collision)
    expect(await prisma.observedTip.count({ where: { txHash: 'ab12', recipientAccountId: account.id } })).toBe(1)
  })

  // ---- empty-response guard (control-flow no-op) -----------------------------

  // An empty lws response is the routine "no new outputs" poll. It must NOT
  // spuriously REORG existing DETECTED tips even when those tips are old enough to
  // reconcile: the reorg branch is gated on a replay signal (a confirmed tx with
  // id <= account.lastTxId), and runIndexerOnce short-circuits on txs.length === 0
  // before ever consulting it. This locks that control-flow guard.
  test('an empty response with no replay signal leaves DETECTED tips untouched (no spurious REORG)', async () => {
    const userId = await createUser(); created.users.push(userId)
    const postId = await createRoot(userId, 'empty-noop'); created.items.push(postId)
    const account = await seedAccount({ postId })

    // DETECTED tip 'ef56' at height 200 — old enough to reconcile IF the branch
    // ran (200 < 205 - REORG_GRACE_BLOCKS=2 = 203, and 6 conf < 10 final), 3M
    // piconeros already bumped. Cursor is set (lastTxId/lastBlockHash).
    await seedTip({ account, postId, txHash: 'ef56', height: 200, piconeros: 3_000_000n })
    expect((await readItemMsats(postId)).msats).toBe(3_000_000n)

    // NON-reorg EMPTY response: no transactions (so no confirmed tx with id <=
    // lastTxId — no replay signal), blockchain_height past the tip. The empty
    // guard must short-circuit before reconcileReorg, leaving the tip DETECTED.
    const lws = mockLwsFor(account, [], 205)
    await runIndexerOnce({ models: prisma, lwsClient: lws, daemonClient: mockDaemon('hash205') })

    const tip = await prisma.observedTip.findFirst({ where: { txHash: 'ef56', recipientAccountId: account.id } })
    expect(tip.state).toBe('DETECTED') // NOT REORGED
    expect((await readItemMsats(postId)).msats).toBe(3_000_000n) // delta untouched
  })

  // ---- atomicity regression (partial-failure hazard fix) ---------------------

  // Symmetric to the forward-path atomicity test in moneroIndexer.test.js. The
  // P2002 -> reviveIfReorged path must also be atomic. Under the OLD code
  // reviveIfReorged did `update(state=DETECTED, ...)` then `applyTipDetected(...)`
  // WITHOUT a shared transaction: if apply threw after the update committed, the
  // row was DETECTED with msats unbumped, and the next poll's P2002 skipped it
  // forever (state was now DETECTED, not REORGED) — a permanent orphan with a
  // silent ranking under-count. Under the fix they share ONE serializable
  // $transaction so a failed apply rolls the state flip back too (the row stays
  // REORGED -> the next poll retries the revive cleanly).
  test('revive atomicity: if applyTipDetected throws during revive, the state flip rolls back too (row stays REORGED) and a retry succeeds', async () => {
    const userId = await createUser(); created.users.push(userId)
    const postId = await createRoot(userId, 'revive-atomic'); created.items.push(postId)
    const account = await seedAccount({ postId })

    // Pre-existing REORGED tip 'rv99' — msats already reversed to 0 by seedTip.
    await seedTip({ account, postId, txHash: 'rv99', height: 200, piconeros: 5_000_000n, state: 'REORGED' })
    expect((await readItemMsats(postId)).msats).toBe(0n)

    // The new chain re-included 'rv99'; lws returns it again (forward of cursor).
    const lws = mockLwsFor(account, [tx({ id: 1002, hash: 'rv99', height: 200, piconeros: 5_000_000n })], 205)

    // Make applyTipDetected reject on its next invocation. Under the OLD code the
    // observedTip.update (state=DETECTED) had ALREADY committed before this throw,
    // leaving an orphan DETECTED row with unbumped msats; under the fix they share
    // ONE serializable $transaction so the failed apply rolls the update back too.
    applyTipDetected.mockImplementation(async () => { throw new Error('simulated applyTipDetected failure') })
    await expect(runIndexerOnce({ models: prisma, lwsClient: lws, daemonClient: mockDaemon('hash200') }))
      .rejects.toThrow('simulated applyTipDetected failure')

    // No orphan DETECTED: the revive rolled back, so the row is still REORGED and
    // msats is still 0 (applyTipDetected never completed). This is the assertion
    // that FAILS on the pre-fix code.
    const tip = await prisma.observedTip.findFirst({ where: { txHash: 'rv99', recipientAccountId: account.id } })
    expect(tip.state).toBe('REORGED') // the state flip rolled back
    expect((await readItemMsats(postId)).msats).toBe(0n) // applyTipDetected rolled back

    // Restore the real applyTipDetected and re-run the SAME tx. Now the revive
    // succeeds: state -> DETECTED and msats bumped EXACTLY ONCE. This proves the
    // retry-after-failure is clean — no orphan-DETECTED-skipped-forever, no
    // double-bump.
    applyTipDetected.mockImplementation((...args) => realApplyTipDetected(...args))
    await runIndexerOnce({ models: prisma, lwsClient: lws, daemonClient: mockDaemon('hash200') })

    const tipAfter = await prisma.observedTip.findFirst({ where: { txHash: 'rv99', recipientAccountId: account.id } })
    expect(tipAfter.state).toBe('DETECTED') // revived
    expect((await readItemMsats(postId)).msats).toBe(5_000_000n) // bumped exactly once
    expect(await prisma.observedTip.count({ where: { txHash: 'rv99', recipientAccountId: account.id } })).toBe(1)
  })

  // ATOMIC CORRECTNESS SPEC. reconcileReorg wraps `update(state=REORGED)` +
  // `reverseTip(...)` in ONE serializable $transaction so they commit or roll
  // back together. If reverseTip throws between them, the whole txn rolls back ->
  // the tip stays DETECTED (NOT REORGED) and Item.msats is unchanged (reverseTip
  // never completed). This closes the over-credit window the OLD non-atomic shape
  // left: a committed REORGED flip while msats stayed bumped. (This test was a
  // CHARACTERIZATION of the old non-atomic over-credit behaviour; it is rewritten
  // here to lock the fix. Mirrors the forward-path + revive atomicity tests.)
  test('atomic reconcile: a reverseTip failure mid-reconcile rolls back the state flip too (tip stays DETECTED, msats unchanged)', async () => {
    const userId = await createUser(); created.users.push(userId)
    const postId = await createRoot(userId, 'atomic-reconcile'); created.items.push(postId)
    const account = await seedAccount({ postId })

    // DETECTED tip 'cd78' at height 200 (6 conf at chain 205 < 10 final, and
    // 200 < 205-2 so eligible for reconcile), 5M piconeros already bumped.
    await seedTip({ account, postId, txHash: 'cd78', height: 200, piconeros: 5_000_000n })
    expect((await readItemMsats(postId)).msats).toBe(5_000_000n)

    // Real reorg replay: a surviving tx BEHIND the cursor (id 990 <= lastTxId
    // 1001), 'cd78' absent. This triggers reconcileReorg for the DETECTED tip.
    const lws = mockLwsFor(account, [tx({ id: 990, hash: 'survivor', height: 195, piconeros: 1000n, minI: 999 })], 205)

    // Override reverseTip to reject on the next call. reconcileReorg begins the
    // serializable $transaction, runs the state flip, then awaits reverseTip —
    // which throws. The throw rolls the whole txn back, and the error propagates
    // out of runIndexerOnce. afterEach restores the delegate.
    reverseTip.mockImplementation(async () => { throw new Error('simulated reverseTip failure') })
    await expect(runIndexerOnce({ models: prisma, lwsClient: lws, daemonClient: mockDaemon('hash195') }))
      .rejects.toThrow('simulated reverseTip failure')

    // Atomic: the state flip rolled back (stays DETECTED, NOT REORGED) and msats is
    // unchanged (reverseTip never completed). Under the OLD non-atomic code the
    // state flip would have committed (REORGED) leaving the over-credit window.
    const tip = await prisma.observedTip.findFirst({ where: { txHash: 'cd78', recipientAccountId: account.id } })
    expect(tip.state).toBe('DETECTED') // the update rolled back too
    expect((await readItemMsats(postId)).msats).toBe(5_000_000n) // reverseTip rolled back
  })
})
