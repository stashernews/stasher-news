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

// Envelope encryption needs a master key in the env (Task 2).
process.env.VIEWKEY_MASTER_KEY = Buffer.from('a'.repeat(32)).toString('base64')

const prisma = new PrismaClient()

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
