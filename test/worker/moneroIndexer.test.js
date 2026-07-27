/* eslint-env jest */

// Integration test for the moneroIndexer poll loop (Task 4 / spec §2.6, §5.4).
//
// runIndexerOnce is the testable core of the pg-boss moneroIndexer job: it
// polls lws for every ACTIVE author MoneroAccount, maps each incoming output
// to a Post via the SubaddressIndex, and idempotently inserts an ObservedTip
// (state DETECTED) — firing applyTipDetected (Task 5) only on a NEW insert so
// msats is never double-bumped.
//
// The lwsClient is the only mock — it is the network boundary (DI seam on
// runIndexerOnce). Everything else is real DB behaviour against a live,
// migrated database, mirroring test/api/monero/ranking.test.js.
//
// Run via the node:22.21.1 helper container:
//   docker exec sn-prisma npx jest test/worker/moneroIndexer.test.js

import { PrismaClient } from '@prisma/client'
import { encryptViewKey } from '@/api/monero/viewkey'
import { runIndexerOnce } from '@/worker/moneroIndexer'
import { applyTipDetected } from '@/api/monero/ranking'

// applyTipDetected is wrapped in a jest.fn so the atomicity regression test
// (last test) can make it throw mid-transaction. By default the mock delegates
// to the real implementation, so every other test exercises real ranking
// behaviour and the existing Task 4 tests are unaffected. jest.mock is
// auto-hoisted above the imports by the transform (the pattern used in
// test/worker/moneroIndexer.reorg.test.js and lib/ssrf.spec.js), so
// worker/moneroIndexer.js — loaded via the import above — also receives the
// mocked applyTipDetected. reverseTip passes through untouched (real).
jest.mock('../../api/monero/ranking', () => {
  const actual = jest.requireActual('../../api/monero/ranking')
  return {
    ...actual,
    applyTipDetected: jest.fn((...args) => actual.applyTipDetected(...args))
  }
})

// Envelope encryption needs a master key in the env (Task 2). Set before any
// encryptViewKey call; getMasterKey() lazily caches it.
process.env.VIEWKEY_MASTER_KEY = Buffer.from('a'.repeat(32)).toString('base64')

const prisma = new PrismaClient()

const ADDR = '5' + '1'.repeat(94) // 95-char Monero address placeholder
const VIEWKEY_HEX = '7e3d' + '0'.repeat(60) // 64-hex private view key placeholder
const SUB_ADDR = '5' + '2'.repeat(94) // a subaddress on that account

// Tracks every row created across tests so afterAll can tear them down in
// FK-safe order: ObservedTip -> SubaddressIndex -> Item -> MoneroViewKey ->
// MoneroAccount -> users.
const created = { users: [], items: [], accounts: [], subs: [] }

// Capture the real applyTipDetected so afterEach can restore the delegating
// implementation after any per-test override (atomicity regression test).
let realApplyTipDetected
beforeAll(() => {
  realApplyTipDetected = jest.requireActual('../../api/monero/ranking').applyTipDetected
})
afterEach(() => {
  applyTipDetected.mockImplementation((...args) => realApplyTipDetected(...args))
})

afterAll(async () => {
  // FK order: ObservedTip -> SubaddressIndex -> Item -> MoneroViewKey -> MoneroAccount -> users
  await prisma.observedTip.deleteMany({ where: { postId: { in: created.items } } })
  for (const id of created.subs) await prisma.subaddressIndex.delete({ where: { id } }).catch(() => {})
  for (const id of created.items) {
    await prisma.itemUserAgg.deleteMany({ where: { itemId: id } })
    await prisma.item.deleteMany({ where: { id } })
  }
  // MoneroViewKey must go before MoneroAccount (FK: viewKey.accountId -> account.id)
  await prisma.moneroViewKey.deleteMany({ where: { accountId: { in: created.accounts } } })
  for (const id of created.accounts) await prisma.moneroAccount.deleteMany({ where: { id } })
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } })
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

// Seed a complete author account: user + ACTIVE MoneroAccount (view-key
// envelope) + a SubaddressIndex pointing at the given post. Returns the
// account row with viewKey included, ready to hand to the mock client.
async function seedAccount ({ majorIndex = 0, minorIndex = 3, postId }) {
  const userId = await createUser(); created.users.push(userId)
  const account = await prisma.moneroAccount.create({
    data: {
      ownerUserId: userId,
      address: ADDR + userId, // unique per test ([address, network] @@unique)
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
    data: { accountId: account.id, majorIndex, minorIndex, address: SUB_ADDR + userId, assignedPostId: postId }
  })
  created.subs.push(sub.id)
  return account
}

// A mock lwsClient that always returns the supplied transactions, ignoring the
// cursor (this is how we simulate lws replaying the same tx to test the
// idempotent-insert path).
function mockClient (transactions, blockchainHeight = 210) {
  return {
    getAddressTxs: jest.fn().mockResolvedValue({ transactions, blockchain_height: blockchainHeight })
  }
}

// A mock daemonClient (Task 6) so cursor-advance block-hash sourcing stays
// offline. These Task 4 tests don't assert lastBlockHash, but runIndexerOnce
// now consults the daemon on every non-empty batch.
function mockDaemon (hash = 'hash200') {
  return { getBlockHashByHeight: jest.fn().mockResolvedValue(hash) }
}

// Convenience: one canonical tip output to (maj_i:0, min_i:3) worth 5 XMR
// (5,000,000,000 piconero? No — 5 XMR = 5e12 piconero. We use 5_000_000
// piconero here = 0.000005 XMR; the absolute value is irrelevant to the test).
// Params are camelCase (StandardJS); the returned object uses lws's wire keys.
function tipTx ({ hash = 'ab12cd', id = 5, majI = 0, minI = 3, piconeros = 5_000_000n, height = 200 } = {}) {
  return { id, hash, piconeros, recipient: { maj_i: majI, min_i: minI }, height, payment_id: null }
}

// A mock lwsClient that returns the supplied transactions ONLY for the account
// under test (empty for all other ACTIVE accounts). runIndexerOnce polls every
// ACTIVE account, and the per-test teardown is in afterAll — so during any given
// test the accounts seeded by earlier tests still exist. An account-agnostic
// mock would feed THIS test's tx into those leaked accounts too, processing a
// different account first and making assertions about the wrong one (a real
// false-green trap — this mirrors mockLwsFor in moneroIndexer.reorg.test.js).
function mockLwsFor (targetAccount, transactions, blockchainHeight = 210) {
  return {
    getAddressTxs: jest.fn(async (acc) =>
      acc.id === targetAccount.id
        ? { transactions, blockchain_height: blockchainHeight }
        : { transactions: [], blockchain_height: blockchainHeight })
  }
}

function readItem (id) {
  return prisma.item.findUnique({ where: { id }, select: { msats: true } })
}

test('runIndexerOnce inserts ObservedTip DETECTED, bumps Item.msats, advances lastTxId', async () => {
  const userId = await createUser(); created.users.push(userId)
  const postId = await createRoot(userId, 'tip-target'); created.items.push(postId)
  const account = await seedAccount({ postId })

  const before = await readItem(postId)
  const client = mockClient([tipTx()])
  await runIndexerOnce({ models: prisma, lwsClient: client, daemonClient: mockDaemon() })

  const tip = await prisma.observedTip.findFirst({ where: { postId } })
  expect(tip).toBeTruthy()
  expect(tip.state).toBe('DETECTED')
  expect(tip.proofType).toBe('INDEXED')
  expect(tip.tipperId).toBeNull() // anonymous P2P tip in v1
  expect(tip.piconeros).toBe(5_000_000n)
  expect(tip.recipientMajor).toBe(0)
  expect(tip.recipientMinor).toBe(3)

  const after = await readItem(postId)
  expect(after.msats - before.msats).toBe(5_000_000n)

  // cursor sent to lws was the account's initial cursor (0n, null)
  expect(client.getAddressTxs).toHaveBeenCalledWith(expect.objectContaining({ id: account.id }), 0n, null)
  const stored = await prisma.moneroAccount.findUnique({ where: { id: account.id } })
  expect(stored.lastTxId).toBe(5n)
})

test('runIndexerOnce is idempotent: a replayed tx does not double-insert or re-bump msats', async () => {
  const userId = await createUser(); created.users.push(userId)
  const postId = await createRoot(userId, 'idempotent-target'); created.items.push(postId)
  await seedAccount({ postId })

  const client = mockClient([tipTx()]) // same tx every call
  await runIndexerOnce({ models: prisma, lwsClient: client, daemonClient: mockDaemon() })
  const afterFirst = await readItem(postId)
  const countAfterFirst = await prisma.observedTip.count({ where: { postId } })
  expect(countAfterFirst).toBe(1)

  // second poll: lws replays the SAME tx (cursor ignored by the mock)
  await runIndexerOnce({ models: prisma, lwsClient: client, daemonClient: mockDaemon() })
  const afterSecond = await readItem(postId)

  expect(await prisma.observedTip.count({ where: { postId } })).toBe(1)
  expect(afterSecond.msats - afterFirst.msats).toBe(0n)
})

test('runIndexerOnce skips a tx whose (maj_i,min_i) has no SubaddressIndex', async () => {
  const userId = await createUser(); created.users.push(userId)
  const postId = await createRoot(userId, 'unmapped-target'); created.items.push(postId)
  await seedAccount({ postId })

  // recipient (0, 999) has no SubaddressIndex row → not a mapped post tip
  const client = mockClient([tipTx({ minI: 999 })])
  const before = await readItem(postId)
  await runIndexerOnce({ models: prisma, lwsClient: client, daemonClient: mockDaemon() })
  const after = await readItem(postId)

  expect(await prisma.observedTip.count({ where: { postId } })).toBe(0)
  expect(after.msats - before.msats).toBe(0n)
})

// ---- atomicity regression (partial-failure hazard fix) ---------------------

// This is the load-bearing test for the money-correctness fix: ObservedTip.create
// and applyTipDetected must commit or roll back TOGETHER in one serializable
// transaction. Under the OLD (non-atomic) code, if the create committed but
// applyTipDetected threw, the next poll's idempotency check (P2002 on the
// @@unique key) skipped the ranking bump FOREVER — a stuck DETECTED row with
// unbumped Item.msats (and a later reorg reversal could over-subtract to
// negative). Here we simulate the apply throw, assert the create rolls back too
// (no orphan DETECTED), then restore apply and prove a clean retry.
test('atomicity: if applyTipDetected throws, the ObservedTip create rolls back too (no orphan DETECTED) and a retry succeeds cleanly', async () => {
  const userId = await createUser(); created.users.push(userId)
  const postId = await createRoot(userId, 'atomicity-target'); created.items.push(postId)
  const account = await seedAccount({ postId })

  const before = await readItem(postId)

  // Make applyTipDetected reject on its next invocation. Under the OLD code the
  // ObservedTip.create had ALREADY committed before this throw, leaving an
  // orphan DETECTED row; under the fix they share ONE serializable $transaction
  // so the failed apply rolls the create back too.
  applyTipDetected.mockImplementation(async () => { throw new Error('simulated applyTipDetected failure') })
  await expect(runIndexerOnce({
    models: prisma,
    lwsClient: mockLwsFor(account, [tipTx({ hash: 'atomic1' })]),
    daemonClient: mockDaemon()
  })).rejects.toThrow('simulated applyTipDetected failure')

  // No orphan DETECTED row and msats untouched — the partial-failure hazard is
  // gone (this is the assertion that FAILS on the pre-fix code).
  expect(await prisma.observedTip.count({
    where: { txHash: 'atomic1', recipientAccountId: account.id }
  })).toBe(0)
  expect((await readItem(postId)).msats - before.msats).toBe(0n)

  // Restore the real applyTipDetected and re-run the SAME tx. Now it succeeds:
  // ObservedTip created DETECTED and msats bumped EXACTLY ONCE. This proves the
  // retry-after-failure is clean — no P2002-skipped-forever, no double-bump.
  applyTipDetected.mockImplementation((...args) => realApplyTipDetected(...args))
  await runIndexerOnce({
    models: prisma,
    lwsClient: mockLwsFor(account, [tipTx({ hash: 'atomic1' })]),
    daemonClient: mockDaemon()
  })

  const tip = await prisma.observedTip.findFirst({
    where: { txHash: 'atomic1', recipientAccountId: account.id }
  })
  expect(tip).toBeTruthy()
  expect(tip.state).toBe('DETECTED')
  expect((await readItem(postId)).msats - before.msats).toBe(5_000_000n) // bumped exactly once
})
