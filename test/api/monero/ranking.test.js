/* eslint-env jest */

// Integration test: the tip-detected ranking hook (api/monero/ranking.js) is
// the bridge between an observed Monero tip and SN's retained ranking trigger.
// applyTipDetected bumps Item.msats (+ ancestor commentMsats) + attributes to
// ItemUserAgg.zapSats; the retained item_ranking BEFORE UPDATE trigger then
// recomputes ranktop/ranklit. reverseTip is the inverse for reorg rollback.
//
// Mirrors api/payIn/types/zap.js onPaid, scoped to msats + ItemUserAgg.zapSats
// + commentMsats propagation (no trust-weighting columns — see task-5-report).
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
    select: { msats: true, ranktop: true, commentMsats: true }
  })
}

test('applyTipDetected bumps Item.msats, ranktop, and ItemUserAgg.zapSats', async () => {
  const u = await createUser(); created.users.push(u)
  const p = await createRoot(u, 'tip-bump'); created.items.push(p)

  const before = await readItem(p)
  await applyTipDetected(p, u, 5000000n)
  const after = await readItem(p)

  expect(after.msats - before.msats).toBe(5000000n)
  expect(after.ranktop).toBeGreaterThan(before.ranktop)

  const agg = await prisma.itemUserAgg.findUnique({
    where: { itemId_userId: { itemId: p, userId: u } }
  })
  expect(agg.zapSats).toBe(5000000n)
})

test('applyTipDetected with null tipper bumps msats but creates no ItemUserAgg row', async () => {
  const u = await createUser(); created.users.push(u)
  const p = await createRoot(u, 'anon-tip'); created.items.push(p)

  const before = await readItem(p)
  await applyTipDetected(p, null, 3000000n)
  const after = await readItem(p)

  expect(after.msats - before.msats).toBe(3000000n)
  expect(after.ranktop).toBeGreaterThan(before.ranktop)

  const count = await prisma.itemUserAgg.count({ where: { itemId: p } })
  expect(count).toBe(0)
})

test('applyTipDetected on a comment propagates commentMsats to ancestor posts', async () => {
  const u = await createUser(); created.users.push(u)
  const root = await createRoot(u, 'prop-root'); created.items.push(root)
  const comment = await createComment(u, root, 'prop-comment'); created.items.push(comment)

  const before = await readItem(root)
  await applyTipDetected(comment, u, 4000000n)
  const after = await readItem(root)

  // root is an ancestor (path @> comment.path) → commentMsats bumps by the tip
  expect(after.commentMsats - before.commentMsats).toBe(4000000n)
  // trigger fires on commentMsats update → ranktop rises (commentMsats*0.25)
  expect(after.ranktop).toBeGreaterThan(before.ranktop)
})

test('reverseTip subtracts msats and lowers ranktop', async () => {
  const u = await createUser(); created.users.push(u)
  const p = await createRoot(u, 'reverse'); created.items.push(p)

  await applyTipDetected(p, u, 5000000n)
  const before = await readItem(p)
  await reverseTip(p, 2000000n)
  const after = await readItem(p)

  expect(before.msats - after.msats).toBe(2000000n)
  expect(after.ranktop).toBeLessThan(before.ranktop)
})
