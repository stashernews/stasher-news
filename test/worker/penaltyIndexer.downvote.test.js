/* eslint-env jest */

// Integration test for the penaltyIndexer downvote-attribution branch (Phase 4 Task 4).
//
// runPenaltyIndexerOnce is the testable core: it processes rewards-wallet outputs
// and, for each output to the PRIMARY address (major 0) carrying a payment_id,
// looks up the DownvotePidMap reverse map, idempotently records an ObservedBurn
// (DETECTED), applies the LOG-scaled ranking penalty (ported from the legacy
// downZap.js onPaid SQL to piconeros), and marks the map consumed. Fee subaddress
// outputs (major 1/2) short-circuit before this branch.
//
// txs are passed in directly (the pg-boss handler fetches them via lwsClient), so
// no network is touched. Everything else is real DB behaviour against a live,
// migrated database, mirroring test/worker/penaltyIndexer.fee.test.js.

import { PrismaClient } from '@prisma/client'
import { runPenaltyIndexerOnce } from '@/worker/penaltyIndexer'

const prisma = new PrismaClient()

const REWARDS_ADDR = '5RpnlDownvote' + 'A'.repeat(85) // unique stagenet placeholder

const created = { users: [], items: [], accounts: [], maps: [], subs: [] }
let rewardsWallet

beforeAll(async () => {
  rewardsWallet = await prisma.moneroAccount.create({
    data: { ownerUserId: null, address: REWARDS_ADDR, label: 'platform_rewards', network: 'STAGENET', status: 'ACTIVE' }
  })
  created.accounts.push(rewardsWallet.id)
})

afterEach(async () => {
  // ObservedBurn rows are created by the indexer (linked to the seeded items),
  // so clean them by postId each test to keep the count-based assertions isolated.
  await prisma.observedBurn.deleteMany({ where: { postId: { in: created.items } } })
})

afterAll(async () => {
  await prisma.observedBurn.deleteMany({ where: { postId: { in: created.items } } })
  for (const pid of created.maps) await prisma.downvotePidMap.deleteMany({ where: { paymentId: pid } })
  for (const id of created.items) {
    await prisma.itemUserAgg.deleteMany({ where: { itemId: id } })
    await prisma.item.deleteMany({ where: { id } })
  }
  for (const name of created.subs) await prisma.sub.deleteMany({ where: { name } })
  for (const id of created.accounts) await prisma.moneroAccount.deleteMany({ where: { id } })
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } })
  await prisma.$disconnect()
})

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(rows[0].id)
  return rows[0].id
}

// Root post: path is the item's own id as a single ltree label (SN convention).
async function createRoot (userId, title) {
  const rows = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", title) VALUES (${userId}::int, ${title})
    RETURNING id::int AS id`
  const id = rows[0].id
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(id)}::ltree WHERE id = ${id}::int`
  created.items.push(id)
  return id
}

let mapSeq = 0
async function seedMap (postId, userId) {
  mapSeq += 1
  const paymentId = 'dd' + String(mapSeq).padStart(14, '0')
  await prisma.downvotePidMap.create({
    data: {
      paymentId,
      postId,
      // nonce is Int4; a small per-run counter is unique and fits (production
      // downZap.js uses Date.now() which is a latent overflow bug — noted in report).
      nonce: mapSeq,
      userId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
    }
  })
  created.maps.push(paymentId)
  return paymentId
}

function lwsDownvoteTx (hash, paymentId, piconeros, height = 1000) {
  return { hash, piconeros: BigInt(piconeros), recipient: { maj_i: 0, min_i: 0 }, height, id: 1, payment_id: paymentId }
}

test('penaltyIndexer maps a payment_id to a postId, creates ObservedBurn DETECTED, bumps downMsats, consumes the map', async () => {
  const userId = await createUser()
  const postId = await createRoot(userId, 'downvote-target')
  const paymentId = await seedMap(postId, userId)
  const PICONEROS = 1_000_000_000n

  await runPenaltyIndexerOnce({ models: prisma, account: rewardsWallet, txs: [lwsDownvoteTx('e5' + 'ab'.repeat(31), paymentId, PICONEROS)] })

  const burn = await prisma.observedBurn.findFirst({ where: { postId } })
  expect(burn).toBeTruthy()
  expect(burn.state).toBe('DETECTED')
  expect(burn.piconeros).toBe(PICONEROS)
  expect(burn.paymentId).toBe(paymentId)

  const item = await prisma.item.findUnique({ where: { id: postId }, select: { downMsats: true } })
  expect(item.downMsats).toBe(PICONEROS)

  const map = await prisma.downvotePidMap.findUnique({ where: { paymentId } })
  expect(map.consumedAt).toBeInstanceOf(Date)
})

test('penaltyIndexer is idempotent across re-polls (no duplicate ObservedBurn, no double downMsats)', async () => {
  const userId = await createUser()
  const postId = await createRoot(userId, 'idempotent-downvote')
  const paymentId = await seedMap(postId, userId)
  const PICONEROS = 1_000_000_000n
  const tx = lwsDownvoteTx('f6' + 'cd'.repeat(31), paymentId, PICONEROS)

  await runPenaltyIndexerOnce({ models: prisma, account: rewardsWallet, txs: [tx] })
  await runPenaltyIndexerOnce({ models: prisma, account: rewardsWallet, txs: [tx] })

  const count = await prisma.observedBurn.count({ where: { postId } })
  expect(count).toBe(1)

  const item = await prisma.item.findUnique({ where: { id: postId }, select: { downMsats: true } })
  expect(item.downMsats).toBe(PICONEROS)
})

test('penaltyIndexer ignores an unknown payment_id (no ObservedBurn, no error)', async () => {
  await expect(
    runPenaltyIndexerOnce({ models: prisma, account: rewardsWallet, txs: [lwsDownvoteTx('a7' + 'ef'.repeat(31), 'unknownpid00000000', 1_000_000_000n)] })
  ).resolves.toBeUndefined()
  expect(await prisma.observedBurn.count()).toBe(0)
})

test('penaltyIndexer applies a LOG-scaled weightedDownVotes delta when the downvoter has territory trust', async () => {
  // Seed a territory + UserSubTrust so zapPostTrust > 0 exercises the LOG CTE.
  const owner = await createUser()
  const subName = 'trusttest' + (++mapSeq) + String(Date.now()).slice(-5)
  await prisma.sub.create({
    data: { name: subName, userId: owner, rankingType: 'WOT', billingType: 'ONCE', billingCost: 0 }
  })
  created.subs.push(subName)

  const downvoter = await createUser()
  await prisma.userSubTrust.create({
    data: { subName, userId: downvoter, zapPostTrust: 1.0, subZapPostTrust: 1.0 }
  })

  // Root post in the seeded territory.
  const postUser = await createUser()
  const rows = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", title) VALUES (${postUser}::int, ${'trusted-downvote'})
    RETURNING id::int AS id`
  const postId = rows[0].id
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(postId)}::ltree, "subNames" = ARRAY[${subName}]::CITEXT[] WHERE id = ${postId}::int`
  created.items.push(postId)

  const paymentId = await seedMap(postId, downvoter)
  const PICONEROS = 1_000_000_000n

  await runPenaltyIndexerOnce({ models: prisma, account: rewardsWallet, txs: [lwsDownvoteTx('b8' + '12'.repeat(31), paymentId, PICONEROS)] })

  const item = await prisma.item.findUnique({ where: { id: postId }, select: { weightedDownVotes: true, subWeightedDownVotes: true, downMsats: true } })
  expect(item.downMsats).toBe(PICONEROS)
  // LOG-scaled: first downvote => zapPostTrust * LOG(piconeros) > 0 (trust applies the ranking weight).
  expect(item.weightedDownVotes).toBeGreaterThan(0)
  expect(item.subWeightedDownVotes).toBeGreaterThan(0)
})
