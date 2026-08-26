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

// ageDays: null = as-created (now); N>0 = backdated N days (matured);
// N<0 = future-dated (day-0 CLAMP — GREATEST(0.0, ·) pins the ramp at 0,
// yielding exactly the 0.7 floor; see the age-factor test for why exactness
// matters here).
async function createUser (ageDays = null) {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  const id = rows[0].id
  if (ageDays != null) {
    await prisma.$executeRaw`UPDATE users SET created_at = now() - (${ageDays} || ' days')::interval WHERE id = ${id}::int`
  }
  return id
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
    select: { piconeros: true, ranktop: true, commentPiconeros: true, upvotes: true, tipRankPiconeros: true, anonTipPiconeros: true, commentTipRankPiconeros: true }
  })
}

test('applyTipDetected bumps Item.piconeros, ranktop, and ItemUserAgg.tipPiconeros', async () => {
  const u = await createUser(); created.users.push(u)
  const tipper = await createUser(); created.users.push(tipper)
  const p = await createRoot(u, 'tip-bump'); created.items.push(p)

  const before = await readItem(p)
  await applyTipDetected(p, tipper, 5000000n)
  const after = await readItem(p)

  expect(after.piconeros - before.piconeros).toBe(5000000n)
  expect(after.ranktop).toBeGreaterThan(before.ranktop)
  expect(after.upvotes - before.upvotes).toBe(1)

  const agg = await prisma.itemUserAgg.findUnique({
    where: { itemId_userId: { itemId: p, userId: tipper } }
  })
  expect(agg.tipPiconeros).toBe(5000000n)
})

test('a repeat tip from the same user does not double-count the tipper', async () => {
  const u = await createUser(); created.users.push(u)
  const tipper = await createUser(); created.users.push(tipper)
  const p = await createRoot(u, 'repeat-tip'); created.items.push(p)

  await applyTipDetected(p, tipper, 3000000n)
  const once = await readItem(p)
  await applyTipDetected(p, tipper, 2000000n)
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
  const tipper = await createUser(); created.users.push(tipper)
  const root = await createRoot(u, 'prop-root'); created.items.push(root)
  const comment = await createComment(u, root, 'prop-comment'); created.items.push(comment)

  const before = await readItem(root)
  await applyTipDetected(comment, tipper, 4000000n)
  const after = await readItem(root)

  // root is an ancestor (path @> comment.path) → commentPiconeros bumps by the tip
  expect(after.commentPiconeros - before.commentPiconeros).toBe(4000000n)
  // trigger fires on commentPiconeros update → ranktop rises (commentPiconeros*0.25)
  expect(after.ranktop).toBeGreaterThan(before.ranktop)
})

test('reverseTip subtracts piconeros, lowers ranktop, and decrements upvotes', async () => {
  const u = await createUser(); created.users.push(u)
  const tipper = await createUser(); created.users.push(tipper)
  const p = await createRoot(u, 'reverse'); created.items.push(p)

  await applyTipDetected(p, tipper, 5000000n)
  const before = await readItem(p)
  await reverseTip(p, tipper, 2000000n)
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

test('applyTipDetected no-ops when the tipper is the item author (defense-in-depth guard)', async () => {
  const u = await createUser(); created.users.push(u)
  const p = await createRoot(u, 'self-tip-guard'); created.items.push(p)

  const before = await readItem(p)
  await applyTipDetected(p, u, 5000000n)
  const after = await readItem(p)

  expect(after.piconeros).toBe(before.piconeros)
  expect(after.upvotes).toBe(before.upvotes)
  const count = await prisma.itemUserAgg.count({ where: { itemId: p } })
  expect(count).toBe(0)
})

test('capped rank: a tip beyond the 0.1 XMR per-tipper cap adds money but no rank', async () => {
  const u = await createUser(30); created.users.push(u) // matured tipper: factor 1.0
  // separate author: u tipping their own post would trip the Task 5 self-tip
  // guard (applyTipDetected returns 0n) and never exercise the cap math
  const author = await createUser(); created.users.push(author)
  const p = await createRoot(author, 'cap-test'); created.items.push(p)

  await applyTipDetected(p, u, 100_000_000_000n) // exactly CAP
  const atCap = await readItem(p)
  expect(atCap.tipRankPiconeros).toBe(100_000_000_000n)

  const delta = await applyTipDetected(p, u, 50_000_000_000n) // +0.05 XMR past cap
  const pastCap = await readItem(p)
  expect(pastCap.piconeros).toBe(150_000_000_000n) // true total still displays
  expect(pastCap.tipRankPiconeros).toBe(100_000_000_000n) // rank term saturated
  expect(delta).toBe(0n)
})

test('new-account factor: a day-0 tipper ranks at the 0.7 floor', async () => {
  const author = await createUser(); created.users.push(author)
  // FUTURE-dated (ageDays -1): created_at is ahead of now(), so the factor's
  // GREATEST(0.0, ·) clamp pins age at 0 -> EXACTLY 0.7. A same-tick
  // createUser() would be a few ms old -> factor 0.7000000124 ->
  // 7_000_000_124n, breaking the exact assertions below.
  const tipper = await createUser(-1); created.users.push(tipper)
  const p = await createRoot(author, 'age-factor'); created.items.push(p)

  const delta = await applyTipDetected(p, tipper, 10_000_000_000n) // 0.01 XMR, under cap
  const item = await readItem(p)
  expect(item.tipRankPiconeros).toBe(7_000_000_000n) // exactly 0.7 x 1e10
  expect(delta).toBe(7_000_000_000n)
  expect(item.piconeros).toBe(10_000_000_000n)
})

test('anonymous collective bucket: first 0.1 XMR counts at 0.7, everything after adds zero', async () => {
  const u = await createUser(); created.users.push(u)
  const p = await createRoot(u, 'anon-bucket'); created.items.push(p)

  const d1 = await applyTipDetected(p, null, 60_000_000_000n) // 0.06 XMR
  expect(d1).toBe(42_000_000_000n) // 0.7 x 6e10
  const d2 = await applyTipDetected(p, null, 60_000_000_000n) // bucket hits 0.12 XMR -> capped at 0.1
  expect(d2).toBe(28_000_000_000n) // 0.7 x (1e11 - 6e10)
  const d3 = await applyTipDetected(p, null, 60_000_000_000n) // past cap
  expect(d3).toBe(0n)

  const item = await readItem(p)
  expect(item.anonTipPiconeros).toBe(180_000_000_000n)
  expect(item.tipRankPiconeros).toBe(70_000_000_000n) // 0.7 x 1e11
  expect(item.piconeros).toBe(180_000_000_000n)
})

test('concurrent anonymous tips do not overshoot the collective cap (row-locked bucket math)', async () => {
  const u = await createUser(); created.users.push(u)
  const p = await createRoot(u, 'anon-concurrency'); created.items.push(p)

  // Two 0.06 XMR anon tips fired concurrently. A pre-read CTE would let both
  // compute their delta from the same empty bucket (2 x 0.7 x 6e10 = 8.4e10
  // rank — overshoot); the inline SET-clause math evaluates against the
  // row-locked latest value, so the second tip waits, re-evaluates, and gets
  // only the remaining headroom. Total rank must be exactly the capped 7e10.
  // (Pre-fix this test is timing-dependent — it fails whenever the second
  // statement starts before the first commits, which Promise.all makes the
  // common case; post-fix it is deterministic.)
  await Promise.all([
    applyTipDetected(p, null, 60_000_000_000n),
    applyTipDetected(p, null, 60_000_000_000n)
  ])
  const item = await readItem(p)
  expect(item.anonTipPiconeros).toBe(120_000_000_000n)
  expect(item.tipRankPiconeros).toBe(70_000_000_000n) // exactly 0.7 x 1e11 cap — no overshoot
  expect(item.piconeros).toBe(120_000_000_000n)
})

test('comment tips propagate commentTipRankPiconeros with the capped delta', async () => {
  // separate author for the same guard reason as the cap test above: the
  // matured user is the TIPPER, not the comment author
  const author = await createUser(); created.users.push(author)
  const u = await createUser(30); created.users.push(u) // matured tipper: factor 1.0
  const root = await createRoot(author, 'cap-prop-root'); created.items.push(root)
  const comment = await createComment(author, root, 'cap-prop-comment'); created.items.push(comment)

  await applyTipDetected(comment, u, 150_000_000_000n) // 1.5x CAP
  const after = await readItem(root)
  expect(after.commentTipRankPiconeros).toBe(100_000_000_000n) // capped, factor 1.0
  expect(after.commentPiconeros).toBe(150_000_000_000n) // true total
})

test('reverseTip subtracts the stored rank delta exactly', async () => {
  const author = await createUser(); created.users.push(author)
  // Matured tipper (factor 1.0): the delta is EXACTLY the raw amount, so the
  // reversal assertions are integer-exact. (A same-tick fresh tipper drifts to
  // 7_000_000_124n — see the createUser note above.)
  const tipper = await createUser(30); created.users.push(tipper)
  const p = await createRoot(author, 'reverse-capped'); created.items.push(p)

  const delta = await applyTipDetected(p, tipper, 10_000_000_000n) // factor 1.0 x 1e10
  expect(delta).toBe(10_000_000_000n)
  const before = await readItem(p)
  await reverseTip(p, tipper, 10_000_000_000n, delta)
  const after = await readItem(p)
  expect(after.tipRankPiconeros).toBe(0n)
  expect(before.piconeros - after.piconeros).toBe(10_000_000_000n)
})

/* reverseTip — stale-DETECTED reversal SQL shape (audit A-1).
   These assert the GENERATED SQL via a mocked tx (pure capture — no DB):
   the inverse must match the ADD path branch-for-branch. Prisma
   parameterizes interpolated values, so numeric amounts NEVER appear in
   the SQL text — amount assertions run against the captured values. */
describe('reverseTip', () => {
  const capture = () => {
    const calls = []
    const tx = {
      $executeRaw: async (sql) => {
        const text = Array.isArray(sql) ? sql.join('') : (sql.text ?? String(sql))
        const vals = Array.isArray(sql?.values) ? [...sql.values] : []
        calls.push({ text, vals })
      }
    }
    return { tx, calls }
  }

  test('attributed inverse decrements upvotes and ItemUserAgg.tipPiconeros', async () => {
    const { tx, calls } = capture()
    await reverseTip(42, 999, 1000000000n, 700000000n, tx)
    const { text, vals } = calls[0]
    expect(text).toContain('"upvotes" = "Item"."upvotes" - 1')
    // no digits after the minus: the amount is a bound parameter
    expect(text).toContain('"tipPiconeros" = GREATEST("ItemUserAgg"."tipPiconeros" - ')
    expect(vals).toContain(1000000000n)
    // the attributed ADD path never increments the anon bucket, so its
    // inverse must not decrement it
    expect(text).not.toContain('anonTipPiconeros" = "Item"."anonTipPiconeros" -')
    expect(text).not.toContain('+ zap.first_vote')
  })

  test('anonymous inverse leaves upvotes alone and decrements the anon bucket only', async () => {
    const { tx, calls } = capture()
    await reverseTip(42, null, 1000000000n, 700000000n, tx)
    const { text } = calls[0]
    // upvotes untouched (no - 1 — the attributed SUB branch's literal text)
    expect(text).toContain('"upvotes" = "Item"."upvotes"')
    expect(text).not.toContain('"upvotes" = "Item"."upvotes" - 1')
    expect(text).toContain('"anonTipPiconeros" = "Item"."anonTipPiconeros" - ')
    expect(text).not.toContain('"tipPiconeros" = GREATEST')
  })

  test('the stored rank delta is subtracted exactly', async () => {
    const { tx, calls } = capture()
    await reverseTip(42, 999, 1000000000n, 123456789n, tx)
    // parameterized: the exact delta travels as a bound value, not SQL text
    expect(calls[0].vals).toContain(123456789n)
  })
})
