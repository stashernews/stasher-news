/* eslint-env jest */

// Lifecycle-flow integration test (A-13 Task 4): award / reclaim / rollover.
// payBounty queues a QUEUED AWARD BountyPayment paying the winner's registered
// address and flips the Item to AWARDED inside the claim transaction (the claim
// UPDATE is the double-award guard). reclaimBounty (EXPIRED only) refunds the
// escrow to the author's wallet (REFUNDED); rolloverBounty (EXPIRED only) sends
// the full escrow balance (bounty + fee) to the rewards pool (ROLLED_OVER).
// All three only QUEUE rows — the signer (Task 5 worker) relays them.
//
// Real-DB test against a live, migrated dev stack — mirroring the seeding
// patterns of test/api/bountyFunding.test.js (deterministic fee config, unique
// user/item ids, tracked cleanup).

import { PrismaClient } from '@prisma/client'
import bountyResolver from '@/api/resolvers/bounty'
import { bountyFeePiconeros } from '@/api/monero/bounties'

process.env.MONERO_NETWORK = 'stagenet'
process.env.PLATFORM_REWARDS_ADDRESS = '5' + '3'.repeat(94)

const { payBounty, reclaimBounty, rolloverBounty } = bountyResolver.Mutation

const prisma = new PrismaClient()

// 95-char stagenet-prefixed placeholder addresses (unique per [address, network]).
const WINNER_ADDR = '5' + '2'.repeat(94)
const AUTHOR_ADDR = '5' + '4'.repeat(94)

// Deterministic fee config: min 0.01 XMR / 1%. With a 1e11 piconeros bounty the
// floor dominates (max(1e9, 1e10) = 1e10), giving exact, readable math.
const FEE_CONFIG = { bountyFeeMinPiconeros: 10_000_000_000n, bountyFeePct: 1 }
const BOUNTY = 100_000_000_000n
const FEE = 10_000_000_000n

const created = { users: [], items: [], accounts: [], payments: [] }

async function cleanupTracked () {
  await prisma.bountyPayment.deleteMany({ where: { itemId: { in: created.items } } })
  await prisma.item.deleteMany({ where: { id: { in: created.items } } })
  await prisma.moneroAccount.deleteMany({ where: { id: { in: created.accounts } } })
  await prisma.user.deleteMany({ where: { id: { in: created.users } } })
  created.users.length = 0
  created.items.length = 0
  created.accounts.length = 0
  created.payments.length = 0
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

async function seedWallet (userId, address, label) {
  const acct = await prisma.moneroAccount.create({
    data: { ownerUserId: userId, address, label, network: 'STAGENET', status: 'ACTIVE' }
  })
  created.accounts.push(acct.id)
  return acct
}

// A bounty on a TOP-LEVEL post (rootId null, the primary use case) + the
// winner comment as its descendant (rootId = the post id, satisfying the
// award guard winner.rootId === (item.rootId ?? item.id) = the post id).
async function seedThread (authorId, winnerId, { bountyStatus = 'FUNDED' } = {}) {
  const item = await prisma.item.create({
    data: {
      userId: authorId,
      title: 'test bounty thread',
      status: 'ACTIVE',
      bountyPiconeros: BOUNTY,
      bountyStatus,
      bountyConfirmedAt: new Date()
    }
  })
  created.items.push(item.id)
  const winner = await prisma.item.create({
    data: { userId: winnerId, parentId: item.id, rootId: item.id, text: 'the winning comment', status: 'ACTIVE' }
  })
  created.items.push(winner.id)
  return { item, winner }
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

async function fundBountyItem (authorId, winnerId) {
  const { item, winner } = await seedThread(authorId, winnerId)
  await ensureFeeConfig()
  return { item, winner }
}

test('payBounty queues a QUEUED AWARD to the winner and flips the item to AWARDED', async () => {
  const authorId = await createUser()
  const winnerId = await createUser()
  await seedWallet(authorId, AUTHOR_ADDR, 'author')
  await seedWallet(winnerId, WINNER_ADDR, 'winner')
  const { item, winner } = await fundBountyItem(authorId, winnerId)

  const payment = await payBounty(null, { id: item.id, winnerCommentId: winner.id }, { me: { id: authorId }, models: prisma })
  created.payments.push(payment.id)

  expect(payment).toMatchObject({
    itemId: item.id,
    winnerUserId: winnerId,
    piconeros: BOUNTY,
    kind: 'AWARD',
    state: 'QUEUED',
    recipientAddress: WINNER_ADDR,
    feePiconeros: FEE
  })
  expect(payment.feePiconeros).toBe(bountyFeePiconeros(item.bountyPiconeros, FEE_CONFIG))
  expect(payment.txHash).toBeNull()
  expect(payment.createdAt).toBeInstanceOf(Date)

  const after = await prisma.item.findUnique({ where: { id: item.id } })
  expect(after.bountyStatus).toBe('AWARDED')
})

test('a second award throws (status already flipped at queue time)', async () => {
  const authorId = await createUser()
  const winnerId = await createUser()
  await seedWallet(authorId, AUTHOR_ADDR, 'author')
  await seedWallet(winnerId, WINNER_ADDR, 'winner')
  const { item, winner } = await fundBountyItem(authorId, winnerId)

  const first = await payBounty(null, { id: item.id, winnerCommentId: winner.id }, { me: { id: authorId }, models: prisma })
  created.payments.push(first.id)

  await expect(payBounty(null, { id: item.id, winnerCommentId: winner.id }, { me: { id: authorId }, models: prisma }))
    .rejects.toThrow('bounty must be funded (current: AWARDED)')

  const count = await prisma.bountyPayment.count({ where: { itemId: item.id } })
  expect(count).toBe(1)
})

test('payBounty rejects a non-author caller', async () => {
  const authorId = await createUser()
  const winnerId = await createUser()
  const strangerId = await createUser()
  await seedWallet(authorId, AUTHOR_ADDR, 'author')
  await seedWallet(winnerId, WINNER_ADDR, 'winner')
  const { item, winner } = await fundBountyItem(authorId, winnerId)

  await expect(payBounty(null, { id: item.id, winnerCommentId: winner.id }, { me: { id: strangerId }, models: prisma }))
    .rejects.toThrow('only the bounty author can award it')
})

test('payBounty rejects an unauthenticated caller', async () => {
  const authorId = await createUser()
  const winnerId = await createUser()
  const { item, winner } = await fundBountyItem(authorId, winnerId)

  await expect(payBounty(null, { id: item.id, winnerCommentId: winner.id }, { me: null, models: prisma }))
    .rejects.toThrow('you must be logged in')
})

test('payBounty rejects a winner with no registered wallet', async () => {
  const authorId = await createUser()
  const winnerId = await createUser()
  await seedWallet(authorId, AUTHOR_ADDR, 'author')
  const { item, winner } = await fundBountyItem(authorId, winnerId)

  await expect(payBounty(null, { id: item.id, winnerCommentId: winner.id }, { me: { id: authorId }, models: prisma }))
    .rejects.toThrow('the winner must attach a wallet to receive the bounty')
})

test('payBounty rejects a winner outside the bounty thread', async () => {
  const authorId = await createUser()
  const winnerId = await createUser()
  await seedWallet(authorId, AUTHOR_ADDR, 'author')
  await seedWallet(winnerId, WINNER_ADDR, 'winner')
  const { item } = await fundBountyItem(authorId, winnerId)

  const foreignPost = await prisma.item.create({
    data: { userId: winnerId, title: 'unrelated thread', status: 'ACTIVE' }
  })
  created.items.push(foreignPost.id)
  const foreignWinner = await prisma.item.create({
    data: { userId: winnerId, parentId: foreignPost.id, rootId: foreignPost.id, text: 'unrelated comment', status: 'ACTIVE' }
  })
  created.items.push(foreignWinner.id)

  await expect(payBounty(null, { id: item.id, winnerCommentId: foreignWinner.id }, { me: { id: authorId }, models: prisma }))
    .rejects.toThrow('award target must be a comment on this bounty post')

  await expect(payBounty(null, { id: item.id, winnerCommentId: item.id }, { me: { id: authorId }, models: prisma }))
    .rejects.toThrow('award target must be a comment on this bounty post')
})

test('payBounty rejects awarding the bounty author\'s own comment (no self-award)', async () => {
  const authorId = await createUser()
  await seedWallet(authorId, AUTHOR_ADDR, 'author')
  const { item, winner } = await fundBountyItem(authorId, authorId)

  await expect(payBounty(null, { id: item.id, winnerCommentId: winner.id }, { me: { id: authorId }, models: prisma }))
    .rejects.toThrow('you cannot award your own comment')

  const after = await prisma.item.findUnique({ where: { id: item.id } })
  expect(after.bountyStatus).toBe('FUNDED')
  const count = await prisma.bountyPayment.count({ where: { itemId: item.id } })
  expect(count).toBe(0)
})

test('payBounty rejects awarding a deleted comment', async () => {
  const authorId = await createUser()
  const winnerId = await createUser()
  await seedWallet(authorId, AUTHOR_ADDR, 'author')
  await seedWallet(winnerId, WINNER_ADDR, 'winner')
  const { item, winner } = await fundBountyItem(authorId, winnerId)
  await prisma.item.update({ where: { id: winner.id }, data: { deletedAt: new Date() } })

  await expect(payBounty(null, { id: item.id, winnerCommentId: winner.id }, { me: { id: authorId }, models: prisma }))
    .rejects.toThrow('award target comment was deleted')

  const after = await prisma.item.findUnique({ where: { id: item.id } })
  expect(after.bountyStatus).toBe('FUNDED')
  const count = await prisma.bountyPayment.count({ where: { itemId: item.id } })
  expect(count).toBe(0)
})

test('reclaimBounty rejects a bounty that is not EXPIRED', async () => {
  const authorId = await createUser()
  const winnerId = await createUser()
  await seedWallet(authorId, AUTHOR_ADDR, 'author')
  await seedWallet(winnerId, WINNER_ADDR, 'winner')
  const { item } = await fundBountyItem(authorId, winnerId)

  await expect(reclaimBounty(null, { id: item.id }, { me: { id: authorId }, models: prisma }))
    .rejects.toThrow('bounty must be expired (current: FUNDED)')

  const after = await prisma.item.findUnique({ where: { id: item.id } })
  expect(after.bountyStatus).toBe('FUNDED')
})

test('reclaimBounty (EXPIRED) queues a RECLAIM to the author and flips the item to REFUNDED', async () => {
  const authorId = await createUser()
  const winnerId = await createUser()
  await seedWallet(authorId, AUTHOR_ADDR, 'author')
  await seedWallet(winnerId, WINNER_ADDR, 'winner')
  const { item } = await fundBountyItem(authorId, winnerId)
  await prisma.item.update({ where: { id: item.id }, data: { bountyStatus: 'EXPIRED' } })

  const payment = await reclaimBounty(null, { id: item.id }, { me: { id: authorId }, models: prisma })
  created.payments.push(payment.id)

  expect(payment).toMatchObject({
    itemId: item.id,
    winnerUserId: authorId,
    piconeros: BOUNTY,
    kind: 'RECLAIM',
    state: 'QUEUED',
    recipientAddress: AUTHOR_ADDR,
    feePiconeros: FEE
  })

  const after = await prisma.item.findUnique({ where: { id: item.id } })
  expect(after.bountyStatus).toBe('REFUNDED')
})

test('rolloverBounty (EXPIRED) queues a ROLLOVER of bounty + fee to the rewards pool', async () => {
  const authorId = await createUser()
  const winnerId = await createUser()
  await seedWallet(authorId, AUTHOR_ADDR, 'author')
  await seedWallet(winnerId, WINNER_ADDR, 'winner')
  const { item } = await fundBountyItem(authorId, winnerId)
  await prisma.item.update({ where: { id: item.id }, data: { bountyStatus: 'EXPIRED' } })

  const payment = await rolloverBounty(null, { id: item.id }, { me: { id: authorId }, models: prisma })
  created.payments.push(payment.id)

  expect(payment).toMatchObject({
    itemId: item.id,
    winnerUserId: authorId,
    piconeros: BOUNTY + FEE,
    kind: 'ROLLOVER',
    state: 'QUEUED',
    recipientAddress: process.env.PLATFORM_REWARDS_ADDRESS,
    feePiconeros: 0n
  })

  const after = await prisma.item.findUnique({ where: { id: item.id } })
  expect(after.bountyStatus).toBe('ROLLED_OVER')
})

test('reclaim/rollover reject after the bounty left EXPIRED (double-claim race guard)', async () => {
  const authorId = await createUser()
  const winnerId = await createUser()
  await seedWallet(authorId, AUTHOR_ADDR, 'author')
  await seedWallet(winnerId, WINNER_ADDR, 'winner')
  const { item } = await fundBountyItem(authorId, winnerId)
  await prisma.item.update({ where: { id: item.id }, data: { bountyStatus: 'EXPIRED' } })

  const reclaim = await reclaimBounty(null, { id: item.id }, { me: { id: authorId }, models: prisma })
  created.payments.push(reclaim.id)

  await expect(reclaimBounty(null, { id: item.id }, { me: { id: authorId }, models: prisma }))
    .rejects.toThrow('bounty must be expired (current: REFUNDED)')
  await expect(rolloverBounty(null, { id: item.id }, { me: { id: authorId }, models: prisma }))
    .rejects.toThrow('bounty must be expired (current: REFUNDED)')

  const count = await prisma.bountyPayment.count({ where: { itemId: item.id } })
  expect(count).toBe(1)
})

// Regression (2026-08-11 live bug): the fork's item_path trigger restores
// path but NOT rootId (upstream's update_item_path sets both), so every
// app-created comment has rootId NULL and the award guard
// winner.rootId !== (item.rootId ?? item.id) rejects ALL real comments
// ('award target must be a comment on this bounty post' — observed live on
// bounty post 2808 / comment 2884). Production comments are created with
// parentId only; rootId is the trigger's job. This test seeds exactly that
// shape and asserts the award succeeds — RED until the trigger maintains
// rootId.
test('payBounty accepts a comment whose rootId is populated by the item_path trigger (no explicit rootId)', async () => {
  const authorId = await createUser()
  const winnerId = await createUser()
  await seedWallet(authorId, AUTHOR_ADDR, 'author')
  await seedWallet(winnerId, WINNER_ADDR, 'winner')
  const item = await prisma.item.create({
    data: {
      userId: authorId,
      title: 'test bounty thread (trigger rootId)',
      status: 'ACTIVE',
      bountyPiconeros: BOUNTY,
      bountyStatus: 'FUNDED',
      bountyConfirmedAt: new Date()
    }
  })
  created.items.push(item.id)
  const winner = await prisma.item.create({
    // NO rootId here — mirrors production item creation; the item_path
    // trigger must derive it from the parent's path.
    data: { userId: winnerId, parentId: item.id, text: 'the winning comment (no explicit rootId)', status: 'ACTIVE' }
  })
  created.items.push(winner.id)

  const payment = await payBounty(null, { id: item.id, winnerCommentId: winner.id }, { me: { id: authorId }, models: prisma })
  created.payments.push(payment.id)

  expect(payment).toMatchObject({
    itemId: item.id,
    winnerUserId: winnerId,
    kind: 'AWARD',
    state: 'QUEUED'
  })
})

// A-13 award indication: the claim transaction must mark the winning comment
// (bountyAwardedAt) and link the bounty post to it (bountyWinnerCommentId),
// and the bountyWinnerName resolver must resolve the winner's user name.
test('payBounty records the winning comment (bountyAwardedAt + bountyWinnerCommentId) and resolves its author name', async () => {
  const authorId = await createUser()
  const winnerId = await createUser()
  await prisma.user.update({ where: { id: winnerId }, data: { name: 'awardwinner' } })
  await seedWallet(authorId, AUTHOR_ADDR, 'author')
  await seedWallet(winnerId, WINNER_ADDR, 'winner')
  const { item, winner } = await fundBountyItem(authorId, winnerId)

  const payment = await payBounty(null, { id: item.id, winnerCommentId: winner.id }, { me: { id: authorId }, models: prisma })
  created.payments.push(payment.id)

  const post = await prisma.item.findUnique({ where: { id: item.id } })
  expect(post.bountyWinnerCommentId).toBe(winner.id)
  const won = await prisma.item.findUnique({ where: { id: winner.id } })
  expect(won.bountyAwardedAt).not.toBeNull()

  // Resolver: bountyWinnerName joins the winner comment's author.
  const name = await bountyResolver.Item.bountyWinnerName(
    { bountyWinnerCommentId: winner.id }, {}, { models: prisma })
  expect(name).toBe('awardwinner')
  expect(await bountyResolver.Item.bountyWinnerName({}, {}, { models: prisma })).toBeNull()
})
