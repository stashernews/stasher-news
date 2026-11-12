/* eslint-env jest */

// Curator rewards v2 (worker/curatorShares.js computeCuratorShares with
// formula 'V2'): the top-two-thirds cut, accuracy, per-payment minimum, the
// LEGACY timing multiplier ranked by detectedAt, per-(curator, item) amount
// grouping, the share cap and seed-neutral trust below a floor of 1.0.
//
// Real-DB integration test. Every scenario seeds into its own week far in the
// past, so no other fixture can fall inside its window.
//   DATABASE_URL=<isolated-db-url> npm test -- --runTestsByPath test/worker/curatorSharesV2.test.js

import { randomBytes } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import {
  budgetMinTipPiconeros,
  capCuratorShares,
  computeCuratorShares,
  resolveCuratorShareConfig,
  V2_HANDICAP_ZAP_MULT,
  settleCapExcess
} from '@/worker/curatorShares'

jest.mock(`${process.cwd()}/lib/logger`, () => ({ logError: jest.fn() }))

const prisma = new PrismaClient()
const DAY = 24 * 60 * 60 * 1000
const MIN_TIP = 200_000_000n
const TIP = 1_000_000_000n
const POOL = 1_000_000_000_000n
const created = { users: [], items: [], accounts: [], tips: [], trustRows: [] }
let recipient
let weekIndex = 0

// A fresh 7-day window per scenario, starting 2001-01-01 + n weeks.
function nextWindow () {
  const start = new Date(Date.UTC(2001, 0, 1) + weekIndex * 7 * DAY)
  weekIndex += 1
  return { start, end: new Date(start.getTime() + 7 * DAY), at: offset => new Date(start.getTime() + offset * 60 * 1000) }
}

async function createUser () {
  const [row] = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(row.id)
  return row.id
}

async function createPost (userId, weightedVotes, createdAt) {
  const [item] = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", title, "weightedVotes", created_at)
    VALUES (${userId}::int, 'curator v2 test post', ${weightedVotes}, ${createdAt}) RETURNING id::int`
  created.items.push(item.id)
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(item.id)}::ltree WHERE id = ${item.id}::int`
  return item.id
}

async function tip (tipperId, postId, piconeros, detectedAt, confirmedAt = detectedAt) {
  const row = await prisma.observedTip.create({
    data: {
      postId,
      tipperId,
      recipientAccountId: recipient.id,
      paymentId: randomBytes(8).toString('hex'),
      txHash: randomBytes(32).toString('hex'),
      piconeros,
      state: 'CONFIRMED',
      detectedAt,
      confirmedAt
    }
  })
  created.tips.push(row.id)
}

function v2 (w, opts = {}) {
  return computeCuratorShares(w.start, w.end, POOL, {
    formula: 'V2',
    minPayout: 0n,
    topN: 100,
    capShareBps: 10000,
    minTipPiconeros: MIN_TIP,
    ...opts
  }, prisma)
}

// Items without subNames resolve to META_SUB ('stasher'), so trust goes there.
async function setTrust (userId, zapPostTrust) {
  await prisma.userSubTrust.upsert({
    where: { userId_subName: { userId, subName: 'stasher' } },
    create: { userId, subName: 'stasher', zapPostTrust, zapCommentTrust: zapPostTrust },
    update: { zapPostTrust, zapCommentTrust: zapPostTrust }
  })
  created.trustRows.push({ subName: 'stasher', userId })
}

// The 'untraceable' trust seed, created when the database has none.
async function trustSeed () {
  const existing = await prisma.user.findUnique({ where: { name: 'untraceable' }, select: { id: true } })
  if (existing) return { id: existing.id, created: false }
  const id = await createUser()
  await prisma.user.update({ where: { id }, data: { name: 'untraceable' } })
  return { id, created: true }
}

// LEGACY's early-tipper multiplier, which V2 keeps.
const early = rank => 1 + 2 / Math.log(rank + Math.E - 1)

const shareOf = (result, userId) => result.shares.find(s => s.curatorId === userId)?.sharePiconeros ?? 0n
const curatorOf = (result, userId) => result.details.curators.find(c => c.curatorId === userId)

beforeAll(async () => {
  recipient = await prisma.moneroAccount.create({
    data: { label: 'curator-v2-author', address: '5' + randomBytes(47).toString('hex'), network: 'STAGENET', status: 'ACTIVE' }
  })
  created.accounts.push(recipient.id)
})

afterAll(async () => {
  await prisma.observedTip.deleteMany({ where: { id: { in: created.tips } } })
  await prisma.itemUserAgg.deleteMany({ where: { itemId: { in: created.items } } })
  await prisma.item.deleteMany({ where: { id: { in: created.items } } })
  await prisma.moneroAccount.deleteMany({ where: { id: { in: created.accounts } } })
  for (const tr of created.trustRows) {
    await prisma.userSubTrust.deleteMany({ where: { subName: tr.subName, userId: tr.userId } })
  }
  await prisma.user.deleteMany({ where: { id: { in: created.users } } })
  await prisma.$disconnect()
})

describe('configuration', () => {
  test('defaults resolve to LEGACY with the documented V2 parameters', () => {
    expect(resolveCuratorShareConfig({})).toMatchObject({
      ok: true,
      formula: 'LEGACY',
      params: { accuracyExponent: 0.25, amountExponent: 0.25, minTipPiconeros: MIN_TIP, capShareBps: 2500 }
    })
  })

  test('the share cap has its own setting, apart from the per-tipper cap on T', () => {
    expect(resolveCuratorShareConfig({ curatorTipCapShareBps: 9000 }).params.capShareBps).toBe(2500)
    expect(resolveCuratorShareConfig({ curatorShareCapBps: 3500 }).params.capShareBps).toBe(3500)
  })

  test('any invalid parameter fails closed to LEGACY', () => {
    for (const bad of [
      { curatorShareFormula: 'V3' },
      { curatorShareFormula: 'V2', curatorAccuracyExponent: 2 },
      { curatorShareFormula: 'V2', curatorAmountExponent: -0.1 },
      { curatorShareFormula: 'V2', curatorMinTipPiconeros: 0n },
      { curatorShareFormula: 'V2', curatorShareCapBps: 0 },
      { curatorShareFormula: 'V2', curatorShadowTrustWeightFloor: 1.5 },
      { curatorShareFormula: 'V2', curatorMinAccountAgeDays: -1 },
      { curatorShareFormula: 'V2', curatorMinAccountAgeDays: 1.5 },
      { curatorShareFormula: 'V2', curatorMinAccountAgeDays: '7' }
    ]) {
      const resolved = resolveCuratorShareConfig(bad)
      expect(resolved.ok).toBe(false)
      expect(resolved.formula).toBe('LEGACY')
    }
  })

  test('the account age defaults to 7 days and accepts 0', () => {
    expect(resolveCuratorShareConfig({}).params.minAccountAgeDays).toBe(7)
    expect(resolveCuratorShareConfig({ curatorMinAccountAgeDays: 0 }).ok).toBe(true)
  })

  test('a pool too large for an exact split is refused before any query', async () => {
    await expect(computeCuratorShares(new Date(0), new Date(1), 2n ** 53n, {}, {}))
      .rejects.toMatchObject({ code: 'pool_too_large' })
  })

  test('the minimum leaves T only when V2 is configured', () => {
    expect(budgetMinTipPiconeros(resolveCuratorShareConfig({ curatorShareFormula: 'V2' }))).toBe(MIN_TIP)
    expect(budgetMinTipPiconeros(resolveCuratorShareConfig({ curatorShareFormula: 'SHADOW' }))).toBeNull()
    expect(budgetMinTipPiconeros(resolveCuratorShareConfig({ curatorShareFormula: 'LEGACY' }))).toBeNull()
  })
})

describe('capCuratorShares', () => {
  test('caps the largest share and gives the excess to the others by weight', () => {
    const { shares, cappedIndexes } = capCuratorShares([0.6, 0.1, 0.1, 0.1, 0.1], 1000n, 250n)
    expect(shares).toEqual([250n, 187n, 187n, 187n, 187n])
    expect(cappedIndexes).toEqual([0])
  })

  test('caps in cascade when redistribution pushes another share over the cap', () => {
    const { shares, cappedIndexes } = capCuratorShares([0.5, 0.3, 0.1, 0.1], 1000n, 300n)
    expect(shares).toEqual([300n, 300n, 200n, 200n])
    expect(cappedIndexes).toEqual([0, 1])
  })

  test('with every recipient capped the remainder is left unplaced', () => {
    const { shares } = capCuratorShares([1, 1, 1], 900n, 250n)
    expect(shares).toEqual([250n, 250n, 250n])
  })
})

describe('settleCapExcess', () => {
  // Pool 1000, cap 400. Weights 0.5 / 0.375 / 0.125 give uncapped shares
  // 500 / 375 / 125; holding the cap leaves 100 of excess. Among the two
  // uncapped curators the leftover splits 3 : 1.
  const held = ({ minPayout = 0n } = {}) => {
    const row = (curatorId, totalProportion, uncappedPiconeros) => ({
      curatorId,
      totalProportion,
      uncappedPiconeros,
      sharePiconeros: uncappedPiconeros > 400n ? 400n : uncappedPiconeros,
      earns: [{ type: 'TIP_POST', rank: curatorId, typeProportion: totalProportion, hitItems: 1, tippedItems: 1 }]
    })
    return {
      excessPiconeros: 100n,
      capPiconeros: 400n,
      minPayout,
      poolPiconeros: 1000n,
      ranked: [row(1, 0.5, 500n), row(2, 0.375, 375n), row(3, 0.125, 125n)]
    }
  }
  const sharesOf = result => Object.fromEntries(result.shares.map(s => [s.curatorId, s.sharePiconeros]))

  test('with nothing left over, curators keep their capped shares', () => {
    const result = settleCapExcess(held(), 0n)
    expect(sharesOf(result)).toEqual({ 1: 400n, 2: 375n, 3: 125n })
    expect(result.placedPiconeros).toBe(0n)
  })

  test('the leftover goes to the uncapped curators by weight', () => {
    const result = settleCapExcess(held(), 20n)
    expect(sharesOf(result)).toEqual({ 1: 400n, 2: 390n, 3: 130n })
    expect(result.placedPiconeros).toBe(20n)
  })

  test('nobody is lifted above the cap; the rest goes to those still under it', () => {
    const result = settleCapExcess(held(), 100n)
    expect(sharesOf(result)).toEqual({ 1: 400n, 2: 400n, 3: 200n })
    expect(result.placedPiconeros).toBe(100n)
  })

  test('a curator below the minimum payout is paid once the leftover lifts them over it', () => {
    expect(sharesOf(settleCapExcess(held({ minPayout: 130n }), 0n))).toEqual({ 1: 400n, 2: 375n })
    expect(sharesOf(settleCapExcess(held({ minPayout: 130n }), 20n))).toEqual({ 1: 400n, 2: 390n, 3: 130n })
  })

  test('the leftover never exceeds the held excess', () => {
    expect(settleCapExcess(held(), 10_000n).placedPiconeros).toBe(100n)
  })

  test('a ceiling below the cap stops that curator early; the rest goes to the others', () => {
    const result = settleCapExcess(held(), 100n, { ceilings: new Map([[2, 380n]]) })
    expect(sharesOf(result)).toEqual({ 1: 400n, 2: 380n, 3: 220n })
    expect(result.placedPiconeros).toBe(100n)
  })

  test('a ceiling at or below the current share gives that curator nothing', () => {
    const result = settleCapExcess(held(), 20n, { ceilings: new Map([[2, 300n]]) })
    expect(sharesOf(result)).toEqual({ 1: 400n, 2: 375n, 3: 145n })
  })
})

describe('V2 shares', () => {
  test('the top two thirds by weighted votes qualify: CEIL(5 × 2/3) = 4 of 5 posts', async () => {
    const w = nextWindow()
    const author = await createUser()
    const posts = []
    for (const wv of [50, 40, 30, 20, 10]) posts.push(await createPost(author, wv, w.at(0)))
    const tippers = []
    for (let i = 0; i < posts.length; i++) {
      tippers.push(await createUser())
      await tip(tippers[i], posts[i], TIP, w.at(10 + i))
    }

    const result = await v2(w)

    expect(result.shares.map(s => s.curatorId).sort((a, b) => a - b)).toEqual(tippers.slice(0, 4).sort((a, b) => a - b))
  })

  test('accuracy multiplies the weight by (hits / tipped)^α', async () => {
    const w = nextWindow()
    const author = await createUser()
    const top = await createPost(author, 50, w.at(0))
    const second = await createPost(author, 40, w.at(0))
    const low = await createPost(author, 10, w.at(0))
    const precise = await createUser()
    const broad = await createUser()
    // Both tip both qualifying posts at the same rank pattern; broad also tips
    // the non-qualifying post.
    await tip(precise, top, TIP, w.at(10))
    await tip(broad, top, TIP, w.at(11))
    await tip(broad, second, TIP, w.at(12))
    await tip(precise, second, TIP, w.at(13))
    await tip(broad, low, TIP, w.at(14))

    const withAccuracy = await v2(w)
    const without = await v2(w, { accuracyExponent: 0 })

    expect(curatorOf(withAccuracy, broad).post).toEqual({ hitItems: 2, tippedItems: 3 })
    expect(curatorOf(withAccuracy, precise).post).toEqual({ hitItems: 2, tippedItems: 2 })
    const ratio = r => Number(shareOf(r, broad)) / Number(shareOf(r, precise))
    expect(ratio(withAccuracy) / ratio(without)).toBeCloseTo((2 / 3) ** 0.25, 4)
  })

  test('a tip below the minimum earns nothing, takes no rank and counts against accuracy', async () => {
    const w = nextWindow()
    const author = await createUser()
    const top = await createPost(author, 50, w.at(0))
    const low = await createPost(author, 10, w.at(0))
    const dust = await createUser()
    const first = await createUser()
    const second = await createUser()
    await tip(dust, top, MIN_TIP - 1n, w.at(5))
    await tip(first, top, TIP, w.at(10))
    await tip(second, top, TIP, w.at(11))
    await tip(first, low, MIN_TIP - 1n, w.at(12))

    const result = await v2(w, { accuracyExponent: 0 })

    expect(shareOf(result, dust)).toBe(0n)
    // first keeps rank 1 despite the earlier dust tip: share ratio is m(2) : m(1).
    expect(Number(shareOf(result, second)) / Number(shareOf(result, first))).toBeCloseTo(early(2) / early(1), 4)
    expect(curatorOf(result, first).post).toEqual({ hitItems: 1, tippedItems: 2 })
  })

  test('timing ranks follow detectedAt, not confirmedAt', async () => {
    const w = nextWindow()
    const author = await createUser()
    const post = await createPost(author, 50, w.at(0))
    const seenFirst = await createUser()
    const confirmedFirst = await createUser()
    await tip(seenFirst, post, TIP, w.at(10), w.at(30))
    await tip(confirmedFirst, post, TIP, w.at(20), w.at(25))

    const result = await v2(w)

    expect(Number(shareOf(result, confirmedFirst)) / Number(shareOf(result, seenFirst))).toBeCloseTo(early(2) / early(1), 4)
  })

  test('splitting a tip into pieces earns the same as one tip of the total', async () => {
    const shareFraction = async split => {
      const w = nextWindow()
      const author = await createUser()
      const post = await createPost(author, 50, w.at(0))
      const splitter = await createUser()
      const other = await createUser()
      await tip(other, post, 4n * TIP, w.at(5))
      if (split) {
        for (let i = 0; i < 4; i++) await tip(splitter, post, TIP, w.at(10 + i))
      } else {
        await tip(splitter, post, 4n * TIP, w.at(10))
      }
      const result = await v2(w)
      return Number(shareOf(result, splitter)) / Number(result.distributedPiconeros)
    }

    expect(await shareFraction(true)).toBeCloseTo(await shareFraction(false), 6)
  })

  test('the share cap holds each curator at capShareBps of the pool', async () => {
    const w = nextWindow()
    const author = await createUser()
    const post = await createPost(author, 50, w.at(0))
    const tippers = []
    for (let i = 0; i < 6; i++) {
      tippers.push(await createUser())
      await tip(tippers[i], post, i === 0 ? 100n * TIP : TIP, w.at(10 + i))
    }

    const result = await v2(w, { capShareBps: 2500 })

    const cap = POOL / 4n
    expect(result.details.capPiconeros).toBe(cap)
    expect(result.details.cappedCuratorIds).toContain(tippers[0])
    expect(shareOf(result, tippers[0])).toBe(cap)
    for (const s of result.shares) expect(s.sharePiconeros <= cap).toBe(true)
    expect(result.distributedPiconeros + result.rolledOverPiconeros).toBe(POOL)
  })

  test('below a floor of 1.0 a trust seed keeps its floor-1.0 share while the others are reweighted by trust', async () => {
    const w = nextWindow()
    const author = await createUser()
    const post = await createPost(author, 50, w.at(0))
    const seed = await trustSeed()
    const low = await createUser()
    const high = await createUser()
    if (seed.created) await setTrust(seed.id, 1.0)
    await setTrust(low, 0.2)
    await setTrust(high, 0.6)
    await tip(seed.id, post, TIP, w.at(10))
    await tip(low, post, TIP, w.at(11))
    await tip(high, post, TIP, w.at(12))

    const full = await v2(w, { trustWeightFloor: 1.0 })
    const half = await v2(w, { trustWeightFloor: 0.5 })

    expect(Number(shareOf(half, seed.id)) / Number(shareOf(full, seed.id))).toBeCloseTo(1, 6)
    // low : high moves by (0.5 + 0.5 × 0.2) / (0.5 + 0.5 × 0.6) = 0.75.
    const ratio = r => Number(shareOf(r, low)) / Number(shareOf(r, high))
    expect(ratio(half) / ratio(full)).toBeCloseTo(0.75, 6)
  })

  test('excluded curators keep their rank but are never paid', async () => {
    const w = nextWindow()
    const author = await createUser()
    const post = await createPost(author, 50, w.at(0))
    const excluded = await createUser()
    const second = await createUser()
    const third = await createUser()
    await tip(excluded, post, TIP, w.at(10))
    await tip(second, post, TIP, w.at(11))
    await tip(third, post, TIP, w.at(12))

    const result = await v2(w, { excludedCuratorIds: [excluded] })

    expect(shareOf(result, excluded)).toBe(0n)
    // second is rank 2, third rank 3: ratio m(3) / m(2).
    expect(Number(shareOf(result, third)) / Number(shareOf(result, second))).toBeCloseTo(early(3) / early(2), 4)
  })

  test('a handicapped account weighs V2_HANDICAP_ZAP_MULT (0.35) of an equal tip', async () => {
    const w = nextWindow()
    const author = await createUser()
    const post = await createPost(author, 50, w.at(0))
    const seed = await trustSeed()
    const other = await createUser()
    await tip(seed.id, post, TIP, w.at(10))
    await tip(other, post, TIP, w.at(11))

    const result = await v2(w)

    expect(V2_HANDICAP_ZAP_MULT).toBe(0.35)
    expect(Number(shareOf(result, seed.id)) / Number(shareOf(result, other))).toBeCloseTo(0.35 * early(1) / early(2), 4)
  })

  test('accounts younger than minAccountAgeDays at periodEnd are not paid but keep their rank', async () => {
    const w = nextWindow()
    const author = await createUser()
    const post = await createPost(author, 50, w.at(0))
    const young = await createUser()
    const second = await createUser()
    const third = await createUser()
    const setCreated = (id, at) => prisma.$executeRaw`UPDATE users SET created_at = ${at} WHERE id = ${id}::int`
    await setCreated(young, new Date(w.end.getTime() - 3 * DAY))
    await setCreated(second, new Date(w.end.getTime() - 30 * DAY))
    await setCreated(third, new Date(w.end.getTime() - 7 * DAY))
    await tip(young, post, TIP, w.at(10))
    await tip(second, post, TIP, w.at(11))
    await tip(third, post, TIP, w.at(12))

    const gated = await v2(w, { minAccountAgeDays: 7 })
    const open = await v2(w)

    expect(shareOf(gated, young)).toBe(0n)
    expect(shareOf(open, young)).toBeGreaterThan(0n)
    // exactly 7 days old qualifies; ranks are unchanged by the gate.
    expect(Number(shareOf(gated, third)) / Number(shareOf(gated, second))).toBeCloseTo(early(3) / early(2), 4)
  })
})
