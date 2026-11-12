/* eslint-env jest */

// Isolated-DB integration test for computeContributorShares. Seeds users, posts, tips
// and trust rows, so it must only run against a migrated, dedicated *_test
// database:
//   DATABASE_URL=postgresql://sn:changeme@127.0.0.1:5431/stasher_contributor_pool_test?schema=public \
//     npm test -- --runTestsByPath test/worker/contributorShares.test.js

import { PrismaClient } from '@prisma/client'
import { CONTRIBUTOR_EXCLUDED_NYMS, computeContributorShares, readWindowStart } from '@/worker/contributorShares'
import { resolveContributorPoolConfig } from '@/lib/contributorPool'
import { HANDICAP_NYMS } from '@/lib/founderNyms'

const ISOLATED_DB = (() => {
  try {
    return ['/stasher_contributor_pool_test'].includes(new URL(process.env.DATABASE_URL).pathname)
  } catch { return false }
})()
const describeDb = ISOLATED_DB ? describe : describe.skip

const prisma = new PrismaClient()
const DAY = 24 * 60 * 60 * 1000
const WEEK_START = new Date('2026-01-12T00:00:00Z') // a Monday
const POST_AT = new Date(WEEK_START.getTime() - 10 * DAY) // inside [-14d, -7d)
const PARAMS = resolveContributorPoolConfig({
  contributorPoolMode: 'SHADOW',
  contributorShareBps: 1500,
  contributorTopN: 5,
  contributorWinnerCapBps: 4000,
  contributorCombinedCapBps: 0,
  contributorMinTipPiconeros: 500000000n,
  contributorTrustThreshold: 0.1,
  contributorMinTrustedTippers: 3,
  contributorTipperCapBps: 3334,
  contributorBreadthTarget: 5,
  contributorReciprocityMult: 0.5,
  contributorReciprocityDays: 30,
  contributorCommentBonusBps: 500,
  contributorCommentBonusMax: 8,
  contributorMinAccountAgeDays: 14,
  contributorLengthFloor: 0.6,
  contributorLengthScaleWords: 100,
  contributorLengthCapWords: 1500
}).params

const created = { users: [], items: [], tips: [], accounts: [], distributions: [] }
let seq = 0
let recipient

async function user (createdAt = new Date(WEEK_START.getTime() - 90 * DAY), { wallet = true } = {}) {
  const [{ id }] = await prisma.$queryRaw`INSERT INTO users (created_at) VALUES (${createdAt}) RETURNING id::int AS id`
  created.users.push(id)
  if (wallet) {
    seq += 1
    const a = await prisma.moneroAccount.create({
      data: { ownerUserId: id, address: 'W' + '5'.repeat(90) + String(seq).padStart(4, '0'), label: 't', network: 'STAGENET', status: 'ACTIVE' }
    })
    created.accounts.push(a.id)
  }
  return id
}

async function trust (userId, value) {
  await prisma.$executeRaw`INSERT INTO "UserSubTrust" ("subName", "userId", "zapPostTrust") VALUES ('stasher', ${userId}::int, ${value}::float)`
}

async function post (authorId, { at = POST_AT, text = 'word '.repeat(200), url = null, pollCost = null, bounty = null, disqualified = false } = {}) {
  const [{ id }] = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", title, text, url, "pollCost", "bountyPiconeros", created_at,
      "contributorDisqualifiedAt")
    VALUES (${authorId}::int, 'p', ${text}, ${url}, ${pollCost}::int, COALESCE(${bounty}::bigint, 0), ${at},
      ${disqualified ? new Date() : null})
    RETURNING id::int AS id`
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(id)}::ltree WHERE id = ${id}::int`
  created.items.push(id)
  return id
}

async function tip (postId, tipperId, mXmr, confirmedAt) {
  seq += 1
  const t = await prisma.observedTip.create({
    data: {
      txHash: 'ct' + seq,
      postId,
      tipperId,
      recipientAccountId: recipient.id,
      recipientMajor: 0,
      recipientMinor: 0,
      paymentId: 'cptest' + String(seq).padStart(8, '0') + '00000000',
      piconeros: BigInt(Math.round(mXmr * 1e9)),
      height: 2000,
      confirmations: 10,
      state: 'CONFIRMED',
      proofType: 'INDEXED',
      confirmedAt
    }
  })
  created.tips.push(t.id)
}

// An author post tipped by `n` trusted tippers (trust 0.5, 1 mXMR each).
async function tippedPost (n = 3, postOpts = {}, authorId) {
  const author = authorId ?? await user()
  const id = await post(author, postOpts)
  for (let k = 0; k < n; k++) {
    const t = await user()
    await trust(t, 0.5)
    await tip(id, t, 1, new Date((postOpts.at ?? POST_AT).getTime() + 3600_000))
  }
  return { id, author }
}

const run = (excludedIds = []) => computeContributorShares(prisma, { weekStart: WEEK_START, params: PARAMS, excludedIds })
const wonIds = r => r.winners.map(w => w.itemId)

describeDb('computeContributorShares', () => {
  beforeAll(async () => {
    recipient = await prisma.moneroAccount.create({
      data: { ownerUserId: null, address: 'R' + '5'.repeat(94), label: 'r', network: 'STAGENET', status: 'ACTIVE' }
    })
    created.accounts.push(recipient.id)
  })

  afterEach(async () => {
    await prisma.rewardDistribution.deleteMany({ where: { id: { in: created.distributions } } })
    await prisma.observedTip.deleteMany({ where: { id: { in: created.tips } } })
    await prisma.item.deleteMany({ where: { id: { in: created.items } } })
    await prisma.userSubTrust.deleteMany({ where: { userId: { in: created.users } } })
    await prisma.moneroAccount.deleteMany({ where: { ownerUserId: { in: created.users } } })
    await prisma.user.deleteMany({ where: { id: { in: created.users } } })
    created.users = []; created.items = []; created.tips = []; created.distributions = []
  })

  afterAll(async () => {
    await prisma.moneroAccount.deleteMany({ where: { id: { in: created.accounts } } })
    await prisma.$disconnect()
  })

  it('wins with three trusted tippers and records score fields', async () => {
    const { id } = await tippedPost(3)
    const r = await run()
    expect(wonIds(r)).toEqual([id])
    const w = r.winners[0]
    expect(w.trustedTippers).toBe(3)
    expect(w.S).toBeGreaterThan(0)
    expect(w.recipientAddress).toMatch(/^W5/) // the author's own wallet, from the candidate query
    expect(w.weight).toBeGreaterThan(0)
    expect(r.window[0].toISOString()).toBe('2025-12-29T00:00:00.000Z')
    expect(r.window[1].toISOString()).toBe('2026-01-05T00:00:00.000Z')
  })

  it('applies the candidate window edges: start inclusive, end exclusive', async () => {
    const start = new Date(WEEK_START.getTime() - 14 * DAY)
    const end = new Date(WEEK_START.getTime() - 7 * DAY)
    const a = await tippedPost(3, { at: start })
    await tippedPost(3, { at: end })
    await tippedPost(3, { at: new Date(start.getTime() - 1) })
    const r = await run()
    expect(r.candidates).toBe(1)
    expect(wonIds(r)).toEqual([a.id])
    expect(r.winners).toHaveLength(1)
  })

  it('excludes a tip at exactly createdAt + 7d but keeps one just before', async () => {
    const author = await user()
    const id = await post(author)
    const t1 = await user(); const t2 = await user(); const t3 = await user()
    for (const t of [t1, t2, t3]) await trust(t, 0.5)
    await tip(id, t1, 1, new Date(POST_AT.getTime() + 7 * DAY - 1))
    await tip(id, t2, 1, new Date(POST_AT.getTime() + 7 * DAY - 1))
    await tip(id, t3, 1, new Date(POST_AT.getTime() + 7 * DAY)) // outside
    const r = await run()
    expect(r.winners).toHaveLength(0)
    expect(r.scored.find(s => s.itemId === id).trustedTippers).toBe(2)
  })

  it('scores a zero-trust sock ring as not qualifying', async () => {
    const author = await user()
    const id = await post(author)
    for (let k = 0; k < 8; k++) {
      const s = await user()
      await tip(id, s, 1000, new Date(POST_AT.getTime() + 3600_000))
    }
    const r = await run()
    const s = r.scored.find(x => x.itemId === id)
    expect(s.qualifies).toBe(false)
    expect(s.trustedTippers).toBe(0)
    expect(r.winners).toHaveLength(0)
  })

  it('does not qualify n = 2 and counts a near miss', async () => {
    const { id } = await tippedPost(2)
    const r = await run()
    expect(r.winners).toHaveLength(0)
    expect(r.scored.find(s => s.itemId === id).qualifies).toBe(false)
    expect(r.nearMisses).toBe(1)
  })

  it('skips a wallet-less author and moves the next post up', async () => {
    const noWallet = await user(undefined, { wallet: false })
    await tippedPost(6, {}, noWallet)
    const b = await tippedPost(3)
    const r = await run()
    expect(wonIds(r)).toEqual([b.id])
    expect(r.ineligible.no_wallet).toBe(1)
  })

  it('gives one slot per author, keeping the best post', async () => {
    const author = await user()
    const weak = await tippedPost(3, {}, author)
    const strong = await tippedPost(6, {}, author)
    const r = await run()
    expect(wonIds(r)).toEqual([strong.id])
    expect(r.qualifying).toBe(2)
    expect(r.ranked.map(x => x.itemId)).not.toContain(weak.id)
  })

  it.each([{ feeStatus: 'PENDING_FEE' }, { status: 'STOPPED' }])('excludes a stronger unpublished post and advances the next eligible post: %j', async hiddenState => {
    const visible = await tippedPost(3)
    const hidden = await tippedPost(6)
    await prisma.item.update({ where: { id: hidden.id }, data: hiddenState })
    const r = await computeContributorShares(prisma, { weekStart: WEEK_START, params: { ...PARAMS, topN: 1 }, excludedIds: [] })
    expect(wonIds(r)).toEqual([visible.id])
    expect(r.scored.map(s => s.itemId)).not.toContain(hidden.id)
  })

  it.each([{ feeStatus: 'PENDING_FEE' }, { status: 'STOPPED' }])('counts a trusted comment only after it is public: %j', async hiddenState => {
    const { id } = await tippedPost(3)
    const baseline = (await run()).scored.find(s => s.itemId === id)
    const commenter = await user()
    await trust(commenter, 0.5)
    const [{ id: cid }] = await prisma.$queryRaw`
      INSERT INTO "Item" ("userId", "parentId", "rootId", title, "bountyPiconeros", created_at)
      VALUES (${commenter}::int, ${id}::int, ${id}::int, 'c', 0, ${new Date(POST_AT.getTime() + 7200_000)}) RETURNING id::int AS id`
    created.items.push(cid)
    await prisma.item.update({ where: { id: cid }, data: hiddenState })
    const hidden = (await run()).scored.find(s => s.itemId === id)
    expect(hidden.E).toBe(0)
    expect(hidden.S).toBe(baseline.S)

    await prisma.item.update({ where: { id: cid }, data: { status: 'ACTIVE', feeStatus: 'FEE_PAID' } })
    const visible = (await run()).scored.find(s => s.itemId === id)
    expect(visible.E).toBe(1)
    expect(visible.S).toBeCloseTo(baseline.S * 1.05, 8)
  })

  it('breaks ties by earlier createdAt, then lower id', async () => {
    const early = await tippedPost(3, { at: new Date(POST_AT.getTime() - DAY) })
    const late = await tippedPost(3)
    const r = await run()
    expect(r.ranked.map(x => x.itemId)).toEqual([early.id, late.id])
  })

  it('excludes disqualified, link, poll, bounty, young, anon-style and excluded-author posts', async () => {
    await tippedPost(3, { disqualified: true })
    await tippedPost(3, { url: 'https://example.com' })
    await tippedPost(3, { pollCost: 1 })
    await tippedPost(3, { bounty: 1000 })
    const young = await user(new Date(POST_AT.getTime() - 3 * DAY))
    await tippedPost(3, {}, young)
    const banned = await user()
    await tippedPost(3, {}, banned)
    const r = await run([banned])
    expect(r.winners).toHaveLength(0)
    expect(r.ineligible).toEqual({ disqualified: 1, link_post: 1, poll: 1, bounty: 1, young_account: 1, excluded_author: 1 })
  })

  it('ignores self tips and tips from excluded tippers', async () => {
    const author = await user()
    const id = await post(author)
    await trust(author, 0.9)
    await tip(id, author, 50, new Date(POST_AT.getTime() + 3600_000))
    const excludedTipper = await user()
    await trust(excludedTipper, 0.9)
    await tip(id, excludedTipper, 50, new Date(POST_AT.getTime() + 3600_000))
    const r = await run([excludedTipper])
    expect(r.scored.find(s => s.itemId === id).tipperCount).toBe(0)
  })

  it('never lets a platform account (stasher, sn) author a winner or add tips', async () => {
    const SN = 4502 // reserved platform account ('sn'), migration-seeded
    const [{ created_at: originalCreatedAt }] = await prisma.$queryRaw`SELECT created_at FROM users WHERE id = ${SN}::int`
    const a = await prisma.moneroAccount.create({
      data: { ownerUserId: SN, address: 'F' + '5'.repeat(90) + '0001', label: 't', network: 'STAGENET', status: 'ACTIVE' }
    })
    try {
      await prisma.$executeRaw`UPDATE users SET created_at = ${new Date(WEEK_START.getTime() - 90 * DAY)} WHERE id = ${SN}::int`
      const founderPost = await tippedPost(3, {}, SN)
      // a normal post tipped by two real tippers and the platform account: only 2 count
      const { id } = await tippedPost(2)
      await trust(SN, 0.9)
      await tip(id, SN, 5, new Date(POST_AT.getTime() + 3600_000))

      const r = await run()
      expect(r.ineligible.excluded_author).toBe(1)
      expect(wonIds(r)).not.toContain(founderPost.id)
      expect(r.scored.find(s => s.itemId === id).trustedTippers).toBe(2)
      expect(r.winners).toHaveLength(0)
    } finally {
      // leave the reserved migration-seeded user exactly as found
      await prisma.observedTip.deleteMany({ where: { id: { in: created.tips } } })
      created.tips = []
      await prisma.item.deleteMany({ where: { id: { in: created.items } } })
      created.items = []
      await prisma.userSubTrust.deleteMany({ where: { userId: SN } })
      await prisma.moneroAccount.deleteMany({ where: { id: a.id } })
      await prisma.$executeRaw`UPDATE users SET created_at = ${originalCreatedAt} WHERE id = ${SN}::int`
    }
  })

  it('does not exclude founder accounts outside the platform list', async () => {
    const nym = HANDICAP_NYMS.find(n => !CONTRIBUTOR_EXCLUDED_NYMS.includes(n))
    const u = await prisma.user.create({ data: { name: nym } })
    created.users.push(u.id)
    await prisma.$executeRaw`UPDATE users SET created_at = ${new Date(WEEK_START.getTime() - 90 * DAY)} WHERE id = ${u.id}::int`
    const a = await prisma.moneroAccount.create({
      data: { ownerUserId: u.id, address: 'U' + '5'.repeat(90) + '0001', label: 't', network: 'STAGENET', status: 'ACTIVE' }
    })
    created.accounts.push(a.id)
    const post = await tippedPost(3, {}, u.id)
    const r = await run()
    expect(wonIds(r)).toEqual([post.id])
    expect(r.ineligible.excluded_author).toBeUndefined()
  })

  it('ignores comments from excluded accounts', async () => {
    const { id } = await tippedPost(3)
    const plain = await user()
    const banned = await user()
    await trust(plain, 0.5)
    await trust(banned, 0.5)
    for (const u of [plain, banned]) {
      const [{ id: cid }] = await prisma.$queryRaw`
        INSERT INTO "Item" ("userId", "parentId", "rootId", title, "bountyPiconeros", created_at)
        VALUES (${u}::int, ${id}::int, ${id}::int, 'c', 0, ${new Date(POST_AT.getTime() + 7200_000)}) RETURNING id::int AS id`
      created.items.push(cid)
    }
    const r = await run([banned])
    expect(r.scored.find(s => s.itemId === id).E).toBe(1)
    expect((await run()).scored.find(s => s.itemId === id).E).toBe(2)
  })

  describe('catch-up window', () => {
    const iso = ms => new Date(ms).toISOString()
    const NORMAL_START = WEEK_START.getTime() - 14 * DAY
    const NORMAL_END = WEEK_START.getTime() - 7 * DAY

    async function scoredWindow (endMs, periodEnd = WEEK_START.getTime() - 7 * DAY) {
      const d = await prisma.rewardDistribution.create({
        data: {
          periodStart: new Date(periodEnd - 7 * DAY),
          periodEnd: new Date(periodEnd),
          poolPiconeros: 0n,
          distributedPiconeros: 0n,
          rolledOverPiconeros: 0n,
          payoutCount: 0,
          status: 'COMPLETE',
          contributorParams: { window: [iso(endMs - 7 * DAY), iso(endMs)] }
        }
      })
      created.distributions.push(d.id)
    }

    it('uses the normal week with no scored window on record', async () => {
      expect((await readWindowStart(prisma, WEEK_START)).getTime()).toBe(NORMAL_START)
    })

    it('uses the normal week when the last scored window already reaches the end', async () => {
      await scoredWindow(NORMAL_END)
      expect((await readWindowStart(prisma, WEEK_START)).getTime()).toBe(NORMAL_START)
    })

    it('starts where the last scored window ended after a skipped week', async () => {
      await scoredWindow(NORMAL_START) // contiguous with the normal window: nothing skipped
      expect((await readWindowStart(prisma, WEEK_START)).getTime()).toBe(NORMAL_START)
      await prisma.rewardDistribution.deleteMany({ where: { id: { in: created.distributions } } })
      created.distributions = []
      await scoredWindow(NORMAL_START - 2 * 7 * DAY, WEEK_START.getTime() - 3 * 7 * DAY)
      expect((await readWindowStart(prisma, WEEK_START)).getTime()).toBe(NORMAL_START - 2 * 7 * DAY)
    })

    it('caps the catch-up at four weeks', async () => {
      await scoredWindow(NORMAL_END - 20 * 7 * DAY, WEEK_START.getTime() - 20 * 7 * DAY)
      expect((await readWindowStart(prisma, WEEK_START)).getTime()).toBe(NORMAL_END - 4 * 7 * DAY)
    })

    it('ignores runs that recorded no window (failed selection, OFF)', async () => {
      // an older run with a window two weeks short of the end, then a NEWER run
      // with no window: the older one must still decide the start
      await scoredWindow(NORMAL_START - 7 * DAY, WEEK_START.getTime() - 3 * 7 * DAY)
      const d = await prisma.rewardDistribution.create({
        data: {
          periodStart: new Date(NORMAL_START),
          periodEnd: new Date(NORMAL_END),
          poolPiconeros: 0n,
          distributedPiconeros: 0n,
          rolledOverPiconeros: 0n,
          payoutCount: 0,
          status: 'COMPLETE',
          contributorParams: { errors: ['selection_failed'] }
        }
      })
      created.distributions.push(d.id)
      expect((await readWindowStart(prisma, WEEK_START)).getTime()).toBe(NORMAL_START - 7 * DAY)
    })

    async function unscoredWindow (startMs, periodEnd) {
      const d = await prisma.rewardDistribution.create({
        data: {
          periodStart: new Date(periodEnd - 7 * DAY),
          periodEnd: new Date(periodEnd),
          poolPiconeros: 0n,
          distributedPiconeros: 0n,
          rolledOverPiconeros: 0n,
          payoutCount: 0,
          status: 'COMPLETE',
          contributorParams: { windowNotScored: [iso(startMs), iso(startMs + 7 * DAY)] }
        }
      })
      created.distributions.push(d.id)
    }

    it('a degraded run scores only the normal week', async () => {
      await scoredWindow(NORMAL_START - 3 * 7 * DAY, WEEK_START.getTime() - 4 * 7 * DAY)
      expect((await readWindowStart(prisma, WEEK_START, { degraded: true })).getTime()).toBe(NORMAL_START)
      expect((await readWindowStart(prisma, WEEK_START)).getTime()).toBe(NORMAL_START - 3 * 7 * DAY)
    })

    it('with no scored window, starts at the earliest not-scored (degraded) week', async () => {
      await unscoredWindow(NORMAL_START - 2 * 7 * DAY, WEEK_START.getTime() - 3 * 7 * DAY)
      await unscoredWindow(NORMAL_START - 7 * DAY, WEEK_START.getTime() - 2 * 7 * DAY)
      expect((await readWindowStart(prisma, WEEK_START)).getTime()).toBe(NORMAL_START - 2 * 7 * DAY)
    })

    it('not-scored weeks older than the last scored window are ignored', async () => {
      await unscoredWindow(NORMAL_START - 4 * 7 * DAY, WEEK_START.getTime() - 5 * 7 * DAY)
      await scoredWindow(NORMAL_START - 7 * DAY, WEEK_START.getTime() - 2 * 7 * DAY)
      expect((await readWindowStart(prisma, WEEK_START)).getTime()).toBe(NORMAL_START - 7 * DAY)
    })

    it('scores a skipped week in the next run and reports it', async () => {
      const skipped = await tippedPost(3, { at: new Date(NORMAL_START - 3 * DAY) }) // the week before the normal one
      const current = await tippedPost(3)
      await scoredWindow(NORMAL_START - 7 * DAY, WEEK_START.getTime() - 3 * 7 * DAY)
      const windowStart = await readWindowStart(prisma, WEEK_START)
      const r = await computeContributorShares(prisma, { weekStart: WEEK_START, params: PARAMS, excludedIds: [], windowStart })

      expect(r.catchUpWeeks).toBe(1)
      expect(r.window[0].getTime()).toBe(NORMAL_START - 7 * DAY)
      expect(wonIds(r).sort()).toEqual([skipped.id, current.id].sort())
      // without the catch-up only the current week is seen
      expect((await run()).catchUpWeeks).toBe(0)
      expect(wonIds(await run())).toEqual([current.id])
    })
  })

  it('detects reciprocity within 30 days and not at 31', async () => {
    const authorA = await user()
    const authorB = await user()
    const authorC = await user()
    // pre-existing tipped post by the tipper (to be tipped by the author)
    const tipper = await user()
    await trust(tipper, 0.5)
    const tippersPost = await post(tipper, { at: new Date(POST_AT.getTime() - 40 * DAY) })
    const mk = async (days, author) => {
      const id = await post(author)
      await tip(tippersPost, author, 1, new Date(POST_AT.getTime() - days * DAY))
      await tip(id, tipper, 1, new Date(POST_AT.getTime() + 3600_000))
      return id
    }
    const inside = await mk(29, authorA)
    const outside = await mk(31, authorB)
    const none = await post(authorC)
    await tip(none, tipper, 1, new Date(POST_AT.getTime() + 3600_000))
    const r = await run()
    const rec = id => r.scored.find(s => s.itemId === id).reciprocalTippers
    expect(rec(inside)).toBe(1)
    expect(rec(outside)).toBe(0)
    expect(rec(none)).toBe(0)
  })
})
