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
import { runConfirmFinalizerOnce } from '@/worker/confirmFinalizer'

const prisma = new PrismaClient()

const ADDR = '5' + '3'.repeat(94) // 95-char Monero address placeholder

// Tracks every row created across tests so afterAll can tear them down in
// FK-safe order: ObservedTip -> Item -> MoneroAccount -> users.
const created = { users: [], items: [], accounts: [], tips: [] }

afterAll(async () => {
  await prisma.observedTip.deleteMany({ where: { id: { in: created.tips } } })
  for (const id of created.items) {
    await prisma.itemUserAgg.deleteMany({ where: { itemId: id } })
    await prisma.item.deleteMany({ where: { id } })
  }
  // ObservedTip must go before MoneroAccount (FK: recipientAccountId -> account.id, RESTRICT)
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
      paymentId: null,
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

test('a DETECTED tip at height 200 becomes CONFIRMED at chain height 209 (10 confs) and bumps the author denorm atomically', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createRoot(authorId, 'confirm-target'); created.items.push(postId)
  const account = await seedAccount()
  const tip = await seedTip({ postId, piconeros: 5_000_000n, height: 200, recipientAccountId: account.id })

  expect((await readUser(authorId)).stackedPiconeros).toBe(0n)

  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(209) })

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

  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(208) })

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

  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(9999) })

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
  await runConfirmFinalizerOnce({ models: prisma, daemonClient: client })
  await runConfirmFinalizerOnce({ models: prisma, daemonClient: client })

  const after = await readTip(tip.id)
  expect(after.state).toBe('CONFIRMED')
  expect((await readUser(authorId)).stackedPiconeros).toBe(7_000_000n)
})
