/* eslint-env jest */

// Integration test: the tip-detected ranking hook (api/monero/ranking.js) is
// the bridge between an observed Monero tip and SN's retained ranking trigger.
// applyTipDetected bumps Item.piconeros (+ ancestor commentPiconeros) + attributes to
// ItemUserAgg.tipPiconeros; the retained item_ranking BEFORE UPDATE trigger then
// recomputes ranktop/ranklit. reverseTip is the inverse for reorg rollback.
//
// Mirrors api/payIn/types/zap.js onPaid, scoped to piconeros + ItemUserAgg.tipPiconeros
// + commentPiconeros propagation (no trust-weighting columns — see task-5-report).
//
// Requires a live, migrated database. Run via:
//   docker exec sn-prisma npx jest test/api/monero/ranking.test.js

import { PrismaClient } from '@prisma/client'
import { applyTipDetected, reverseTip } from '@/api/monero/ranking'

const prisma = new PrismaClient()

const created = { users: [], items: [] }

afterAll(async () => {
  // FK order: ItemUserAgg -> Item -> users
  for (const id of created.items) {
    await prisma.itemUserAgg.deleteMany({ where: { itemId: id } })
    await prisma.item.deleteMany({ where: { id } })
  }
  for (const id of created.users) {
    await prisma.user.deleteMany({ where: { id } })
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

// Comment under a root: path is "<rootId>.<commentId>" so root is an ancestor.
async function createComment (userId, rootId, title) {
  const rows = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", "parentId", "rootId", title)
    VALUES (${userId}::int, ${rootId}::int, ${rootId}::int, ${title})
    RETURNING id::int AS id`
  const id = rows[0].id
  const path = `${rootId}.${id}`
  await prisma.$executeRaw`UPDATE "Item" SET path = ${path}::ltree WHERE id = ${id}::int`
  return id
}

function readItem (id) {
  return prisma.item.findUnique({
    where: { id },
    select: { piconeros: true, ranktop: true, commentPiconeros: true, upvotes: true }
  })
}

test('applyTipDetected bumps Item.piconeros, ranktop, and ItemUserAgg.tipPiconeros', async () => {
  const u = await createUser(); created.users.push(u)
  const p = await createRoot(u, 'tip-bump'); created.items.push(p)

  const before = await readItem(p)
  await applyTipDetected(p, u, 5000000n)
  const after = await readItem(p)

  expect(after.piconeros - before.piconeros).toBe(5000000n)
  expect(after.ranktop).toBeGreaterThan(before.ranktop)
  expect(after.upvotes - before.upvotes).toBe(1)

  const agg = await prisma.itemUserAgg.findUnique({
    where: { itemId_userId: { itemId: p, userId: u } }
  })
  expect(agg.tipPiconeros).toBe(5000000n)
})

test('a repeat tip from the same user does not double-count the tipper', async () => {
  const u = await createUser(); created.users.push(u)
  const p = await createRoot(u, 'repeat-tip'); created.items.push(p)

  await applyTipDetected(p, u, 3000000n)
  const once = await readItem(p)
  await applyTipDetected(p, u, 2000000n)
  const twice = await readItem(p)

  expect(twice.piconeros - once.piconeros).toBe(2000000n)
  expect(twice.upvotes - once.upvotes).toBe(0)
})

test('applyTipDetected with null tipper bumps piconeros but creates no ItemUserAgg row', async () => {
  const u = await createUser(); created.users.push(u)
  const p = await createRoot(u, 'anon-tip'); created.items.push(p)

  const before = await readItem(p)
  await applyTipDetected(p, null, 3000000n)
  const after = await readItem(p)

  expect(after.piconeros - before.piconeros).toBe(3000000n)
  expect(after.ranktop).toBeGreaterThan(before.ranktop)
  expect(after.upvotes - before.upvotes).toBe(0)

  const count = await prisma.itemUserAgg.count({ where: { itemId: p } })
  expect(count).toBe(0)
})

test('applyTipDetected on a comment propagates commentPiconeros to ancestor posts', async () => {
  const u = await createUser(); created.users.push(u)
  const root = await createRoot(u, 'prop-root'); created.items.push(root)
  const comment = await createComment(u, root, 'prop-comment'); created.items.push(comment)

  const before = await readItem(root)
  await applyTipDetected(comment, u, 4000000n)
  const after = await readItem(root)

  // root is an ancestor (path @> comment.path) → commentPiconeros bumps by the tip
  expect(after.commentPiconeros - before.commentPiconeros).toBe(4000000n)
  // trigger fires on commentPiconeros update → ranktop rises (commentPiconeros*0.25)
  expect(after.ranktop).toBeGreaterThan(before.ranktop)
})

test('reverseTip subtracts piconeros, lowers ranktop, and decrements upvotes', async () => {
  const u = await createUser(); created.users.push(u)
  const p = await createRoot(u, 'reverse'); created.items.push(p)

  await applyTipDetected(p, u, 5000000n)
  const before = await readItem(p)
  await reverseTip(p, 2000000n)
  const after = await readItem(p)

  expect(before.piconeros - after.piconeros).toBe(2000000n)
  expect(after.ranktop).toBeLessThan(before.ranktop)
  expect(before.upvotes - after.upvotes).toBe(1)
})

test('applyTipDetected bumps weightedVotes/subWeightedVotes by zapTrust x LOG(tipPiconeros)', async () => {
  // Real path feeding the weekly distributor: the tipper's territory trust
  // (UserSubTrust, produced by the nightly trust worker) scales a LOG() tip
  // amount into Item.weightedVotes/subWeightedVotes — the exact upstream
  // zap.js math mirrored by worker/rewardsWalletObserver's downvote path.
  const poster = await createUser(); created.users.push(poster)
  const tipper = await createUser(); created.users.push(tipper)

  // Root post in the 'meta' territory (set explicitly; COALESCE would fall
  // back to 'meta' anyway).
  const rows = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", title) VALUES (${poster}::int, ${'weighted-tip-post'})
    RETURNING id::int AS id`
  const postId = rows[0].id
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(postId)}::ltree, "subNames" = ARRAY['meta']::CITEXT[] WHERE id = ${postId}::int`
  created.items.push(postId)

  // Seed territory trust for the tipper in 'meta'.
  await prisma.userSubTrust.create({
    data: { subName: 'meta', userId: tipper, zapPostTrust: 0.5, subZapPostTrust: 0.25 }
  })

  const before = await prisma.item.findUnique({
    where: { id: postId },
    select: { weightedVotes: true, subWeightedVotes: true }
  })
  await applyTipDetected(postId, tipper, 1_000_000_000n)
  const after = await prisma.item.findUnique({
    where: { id: postId },
    select: { weightedVotes: true, subWeightedVotes: true }
  })

  // Postgres LOG() is base-10: a first tip of 1e9 piconeros yields
  // LOG(1e9 / GREATEST(0, 1)) = LOG(1e9) = 9. weightedVotes += zapTrust * 9,
  // subWeightedVotes += subZapTrust * 9.
  const logSats = Math.log10(1_000_000_000)
  expect(after.weightedVotes - before.weightedVotes).toBeCloseTo(0.5 * logSats, 6)
  expect(after.subWeightedVotes - before.subWeightedVotes).toBeCloseTo(0.25 * logSats, 6)
})

test('anonymous tips (no tipperId) leave weightedVotes untouched (no per-user attribution)', async () => {
  const u = await createUser(); created.users.push(u)
  const p = await createRoot(u, 'anon-weighted'); created.items.push(p)

  const before = await prisma.item.findUnique({
    where: { id: p },
    select: { weightedVotes: true, subWeightedVotes: true }
  })
  await applyTipDetected(p, null, 1_000_000_000n)
  const after = await prisma.item.findUnique({
    where: { id: p },
    select: { weightedVotes: true, subWeightedVotes: true }
  })

  expect(after.weightedVotes).toBe(before.weightedVotes)
  expect(after.subWeightedVotes).toBe(before.subWeightedVotes)
})
