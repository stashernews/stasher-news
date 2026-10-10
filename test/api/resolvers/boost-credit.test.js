/* eslint-env jest */
import { PrismaClient } from '@prisma/client'
import { canUseBoostCreditOnItem } from '@/lib/boost-credit'
import { BOOST_CREDIT_PICONEROS } from '@/lib/quests'
import { availableBoostCredit } from '@/api/quests/boost-credit'
import { useBoostCredit } from '@/api/resolvers/boost-credit'
import { getItemResult } from '@/api/payIn/lib/item'
import { readRewardsInflow } from '@/api/monero/rewardsInflow'
import { readRewardsWalletLedger } from '@/api/monero/rewardsLedger'
import { advanceQuestStreak } from '@/worker/streak'
import userResolvers from '@/api/resolvers/user'
import itemResolvers, { getItem } from '@/api/resolvers/item'
import assertGofacYourself from '../../../api/resolvers/ofac'

// api/resolvers/item.js and user.js drag in heavy ESM-only transitive deps;
// the mocks below break that chain — same pattern as
// test/api/item-monero-wall.test.js + test/api/resolvers/userPrivates.quests.test.js.
jest.mock('../../../api/resolvers/ofac', () => ({
  __esModule: true,
  // Unit-isolated default: redemption tests run with OFAC as an async no-op.
  // Dedicated tests below swap implementations via mockRejectedValueOnce.
  default: jest.fn(async () => {})
}))
jest.mock('../../../lib/webPush', () => ({
  __esModule: true,
  notifyFlameAdvanced: jest.fn(() => Promise.resolve()),
  notifyShieldUsed: jest.fn(() => Promise.resolve()),
  notifyStreakLost: jest.fn(() => Promise.resolve())
}))
jest.mock('../../../components/editor', () => ({ __esModule: true, SNEditor: 'textarea' }))
jest.mock('../../../api/payIn', () => ({ __esModule: true, default: {} }))
jest.mock('../../../lib/lexical/server/html', () => ({ __esModule: true, lexicalHTMLGenerator: async () => '' }))

jest.setTimeout(20_000)

const prisma = new PrismaClient()
const created = { userIds: [], itemIds: [], rewardIds: [], streakIds: [], payInIds: [] }

const DAY_MS = 86_400_000
const CREDIT_TTL_MS = 30 * DAY_MS
const FIXTURE_TITLE = 'boost credit fixture post'

// favor the DB wall clock semantics the worker uses: fixture expiry instants
// come from the JS clock, which shares the host kernel clock with Postgres
async function makeUser () {
  const [row] = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  const userId = Number(row.id)
  created.userIds.push(userId)
  return userId
}

const ts = value => `'${(value instanceof Date ? value.toISOString() : String(value))
  .replace('T', ' ')
  .slice(0, 19)}'::timestamp`

// Raw Item insert + path assignment (prisma cannot write the Unsupported ltree
// column) — mirrors the existing boost suite. `fields` are whitelisted, cast
// binds so the rejection matrix can pin exactly one ineligibility per row.
// Values come from test code only, never from user input.
const ITEM_COLUMN_BINDS = {
  parentId: v => `${Number(v)}::int`,
  bio: v => `${v === true}::boolean`,
  deletedAt: v => ts(v),
  status: v => `'${v}'::"Status"`,
  feeStatus: v => `'${v}'::"ItemFeeStatus"`,
  pollCost: v => `${Number(v)}::int`,
  pollExpiresAt: v => ts(v),
  bountyPiconeros: v => `${BigInt(v)}::bigint`,
  bountyStatus: v => `'${v}'::"BountyStatus"`,
  bountyConfirmedAt: v => ts(v),
  moneroWallEnabledAt: v => ts(v),
  moneroWallPricePiconeros: v => `${BigInt(v)}::bigint`,
  moneroWallThresholdPiconeros: v => `${BigInt(v)}::bigint`,
  subNames: v => `'{${v.join(',')}}'::citext[]`
}

async function makePost (userId, fields = {}) {
  const unknown = Object.keys(fields).filter(c => !ITEM_COLUMN_BINDS[c])
  if (unknown.length) throw new Error(`unknown makePost field(s): ${unknown.join(', ')}`)
  const columns = ['"userId"', 'title']
  const values = [`${Number(userId)}::int`, `'${FIXTURE_TITLE}'`]
  for (const [column, value] of Object.entries(fields)) {
    columns.push(`"${column}"`)
    values.push(ITEM_COLUMN_BINDS[column](value))
  }
  const [row] = await prisma.$queryRawUnsafe(
    `INSERT INTO "Item" (${columns.join(', ')}) VALUES (${values.join(', ')}) RETURNING id::int AS id`)
  const id = Number(row.id)
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(id)}::ltree WHERE id = ${id}::int`
  created.itemIds.push(id)
  return { id }
}

async function makeCredit (userId, fields = {}) {
  const {
    type = 'BOOST',
    expiresAt = new Date(Date.now() + CREDIT_TTL_MS),
    grantedAt = new Date(),
    consumedAt = null,
    itemId = null
  } = fields
  const [row] = await prisma.$queryRaw`
    INSERT INTO "StreakReward" ("userId", created_at, "grantedAt", "expiresAt", "type", "consumedAt", "itemId")
    VALUES (${Number(userId)}::int, now_utc(), ${grantedAt}::timestamp, ${expiresAt}::timestamp,
      ${type}::"StreakRewardType", ${consumedAt}::timestamp, ${itemId}::int)
    RETURNING id::int AS id`
  const id = Number(row.id)
  created.rewardIds.push(id)
  return { id }
}

const readPost = async id => (await prisma.$queryRaw`
  SELECT *, ltree2text(path) AS path FROM "Item" WHERE id = ${Number(id)}::int`)[0]

// Real posts are born through the pay-in engine (ITEM_CREATE PayIn), and the
// META reader inner-joins on that linkage — raw fixture items need the same
// pairing to be visible to the GraphQL item() response path.
async function makeItemCreatePayIn (itemId, payerId) {
  const [payIn] = await prisma.$queryRaw`
    INSERT INTO "PayIn" ("payInType", "payInState", "userId", "piconeros")
    VALUES ('ITEM_CREATE', 'PAID', ${Number(payerId)}::int, 0::bigint)
    RETURNING id::int AS id`
  const payInId = Number(payIn.id)
  created.payInIds.push(payInId)
  await prisma.$queryRaw`
    INSERT INTO "ItemPayIn" ("itemId", "payInId")
    VALUES (${Number(itemId)}::int, ${payInId}::int)`
  return { id: payInId }
}

// The suite's resolver entry point: the exported resolver with the plain
// getItemResult reader (the same raw shape pay-in writes return).
const redeem = (userId, itemId, rewardId) =>
  useBoostCredit(null, { itemId: String(itemId), rewardId: String(rewardId) }, {
    me: { id: userId },
    models: prisma,
    headers: {},
    readItem: (_, { id }, { models }) => getItemResult(models, { id })
  })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// paid/monetary/vote columns whose values a redemption must never touch.
// promoBoostPiconeros is deliberately excluded — it is the only intended move.
const ACCOUNTING_FIELDS = [
  'piconeros', 'boost', 'bountyPiconeros', 'downPiconeros', 'anonTipPiconeros',
  'credits', 'cost', 'tipRankPiconeros', 'netInvestment', 'feeInvestmentPiconeros',
  'weightedVotes', 'subWeightedVotes', 'weightedDownVotes', 'subWeightedDownVotes', 'upvotes'
]
const pick = (row, fields) => Object.fromEntries(fields.map(f => [f, row[f]]))

// Standalone quoted-identifier references to the promotional tables in
// captured SQL. The look-ahead admits whitespace, a comma, a closing paren or
// end-of-string, so `FROM "Item"`, `JOIN "StreakReward" AS x`, `"Item", …`,
// `… FROM "Item")` and `"Item"` at the very end all match — while qualified
// column reads like `"Item"."id"` deliberately do not: those are the job of
// the promoBoostPiconeros column-name assertion below.
const PROMO_TABLE_IN_SQL = /"Item"(?=[\s,)]|$)|"StreakReward"(?=[\s,)]|$)/

afterAll(async () => {
  await prisma.streakReward.deleteMany({ where: { userId: { in: created.userIds } } })
  await prisma.payIn.deleteMany({ where: { id: { in: created.payInIds } } })
  await prisma.item.deleteMany({ where: { id: { in: created.itemIds } } })
  await prisma.streak.deleteMany({ where: { id: { in: created.streakIds } } })
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } })
  await prisma.$disconnect()
})

beforeEach(() => {
  assertGofacYourself.mockClear()
})

describe('canUseBoostCreditOnItem (shared predicate)', () => {
  const basePost = {
    userId: 616,
    parentId: null,
    bio: false,
    deletedAt: null,
    status: 'ACTIVE',
    feeStatus: 'FEE_PAID'
  }

  test('accepts the minimal valid own live post (server shape)', () => {
    expect(canUseBoostCreditOnItem(basePost, 616)).toBe(true)
    expect(canUseBoostCreditOnItem({ ...basePost, feeStatus: 'FEE_NOT_REQUIRED' }, 616)).toBe(true)
  })

  test('accepts the client shape (item.user.id)', () => {
    const { userId, ...client } = { userId: undefined, ...basePost, user: { id: 616 } }
    expect(canUseBoostCreditOnItem({ ...client, user: { id: 616 } }, 616)).toBe(true)
  })

  test.each([
    ['foreign owner', { userId: 4502 }],
    ['comment', { parentId: 1 }],
    ['bio', { bio: true }],
    ['deleted', { deletedAt: new Date() }],
    ['fee pending', { feeStatus: 'PENDING_FEE' }],
    ['fee missing', { feeStatus: null }],
    ['status STOPPED', { status: 'STOPPED' }],
    ['status NO_XMR', { status: 'NO_XMR' }],
    ['status GRACE', { status: 'GRACE' }]
  ])('rejects: %s', (_label, overrides) => {
    expect(canUseBoostCreditOnItem({ ...basePost, ...overrides }, 616)).toBe(false)
  })

  test('rejects missing item, missing user, and the anonymous viewer', () => {
    expect(canUseBoostCreditOnItem(null, 616)).toBe(false)
    expect(canUseBoostCreditOnItem(basePost, null)).toBe(false)
    expect(canUseBoostCreditOnItem(basePost, undefined)).toBe(false)
  })
})

describe('useBoostCredit (real DB redemption)', () => {
  const UNAVAILABLE = 'boost credit unavailable'

  test('redeems the exact credit on the exact post: consume + one promo increment', async () => {
    const userId = await makeUser()
    const post = await makePost(userId)
    const credit = await makeCredit(userId)

    const item = await redeem(userId, post.id, credit.id)
    expect(item.id).toBe(post.id)

    const after = await readPost(post.id)
    expect(after.promoBoostPiconeros).toBe(BOOST_CREDIT_PICONEROS)
    const reward = await prisma.streakReward.findUnique({ where: { id: credit.id } })
    expect(reward.consumedAt).not.toBeNull()
    expect(reward.itemId).toBe(post.id)
  })

  test.each([
    ['foreign owner', async userId => ({ userId, post: await makePost(await makeUser()) })],
    ['comment', async userId => {
      const root = await makePost(userId)
      const post = await makePost(userId, { parentId: root.id })
      return { userId, post }
    }],
    ['bio', async userId => ({ userId, post: await makePost(userId, { bio: true }) })],
    ['deleted', async userId => ({ userId, post: await makePost(userId, { deletedAt: new Date() }) })],
    ['fee pending', async userId => ({ userId, post: await makePost(userId, { feeStatus: 'PENDING_FEE' }) })],
    ['status STOPPED', async userId => ({ userId, post: await makePost(userId, { status: 'STOPPED' }) })],
    ['status NO_XMR', async userId => ({ userId, post: await makePost(userId, { status: 'NO_XMR' }) })],
    ['status GRACE', async userId => ({ userId, post: await makePost(userId, { status: 'GRACE' }) })]
  ])('rejects an ineligible item: %s', async (_label, seed) => {
    const userId = await makeUser()
    const { post } = await seed(userId)
    const credit = await makeCredit(userId)

    await expect(redeem(userId, post.id, credit.id)).rejects.toThrow(UNAVAILABLE)
    expect((await readPost(post.id)).promoBoostPiconeros).toBe(0n)
    const reward = await prisma.streakReward.findUnique({ where: { id: credit.id } })
    expect(reward.consumedAt).toBeNull()
    expect(reward.itemId).toBeNull()
  })

  test.each([
    ['anonymous', {}],
    ['api key', { apiKey: true }]
  ])('rejects a %s caller', async (_label, meOverrides) => {
    const userId = await makeUser()
    const post = await makePost(userId)
    const credit = await makeCredit(userId)
    const me = meOverrides.apiKey ? { id: userId, apiKey: true } : undefined

    await expect(useBoostCredit(null, { itemId: String(post.id), rewardId: String(credit.id) }, {
      me,
      models: prisma,
      headers: {},
      readItem: (_, { id }, { models }) => getItemResult(models, { id })
    })).rejects.toThrow(meOverrides.apiKey ? 'not allowed to be performed via API Key' : 'you must be logged in')

    expect((await readPost(post.id)).promoBoostPiconeros).toBe(0n)
    expect((await prisma.streakReward.findUnique({ where: { id: credit.id } })).consumedAt).toBeNull()
  })

  test('consults the OFAC guard and propagates its refusal without any writes', async () => {
    const userId = await makeUser()
    const post = await makePost(userId)
    const credit = await makeCredit(userId)
    assertGofacYourself.mockRejectedValueOnce(new Error('ofacland'))

    await expect(redeem(userId, post.id, credit.id)).rejects.toThrow('ofacland')
    expect(assertGofacYourself).toHaveBeenCalledTimes(1)
    expect(assertGofacYourself).toHaveBeenCalledWith(
      expect.objectContaining({ models: prisma, headers: {} }))
    expect((await readPost(post.id)).promoBoostPiconeros).toBe(0n)
    expect((await prisma.streakReward.findUnique({ where: { id: credit.id } })).consumedAt).toBeNull()
  })

  test.each([
    ['itemId', 'x'], ['itemId', '0'], ['itemId', '-1'], ['itemId', '1.2'], ['itemId', '2147483648'],
    ['rewardId', 'x'], ['rewardId', '0'], ['rewardId', '-1'], ['rewardId', '1.2'], ['rewardId', '2147483648']
  ])('malformed id is rejected before any database access (%s: %s)', async (field, value) => {
    // every property touch on this models proxy leaves a probe marker, so the
    // assertion also proves nothing (ofac scan, transaction, ...) reached the DB
    const probes = new Set()
    const models = new Proxy({}, { get: (_t, prop) => { probes.add(String(prop)); throw new Error(`db probe reached: ${String(prop)}`) } })
    const userId = await makeUser()

    await expect(useBoostCredit(null, {
      itemId: field === 'itemId' ? value : '7',
      rewardId: field === 'rewardId' ? value : '7'
    }, {
      me: { id: userId }, models, headers: {}, readItem: async () => null
    })).rejects.toThrow(new RegExp(`invalid ${field}`))
    expect(probes.size).toBe(0)
    expect(assertGofacYourself).not.toHaveBeenCalled()
  })

  test.each([
    ['foreign reward', async userId => makeCredit(await makeUser())],
    ['missing reward', async () => {
      // an id beyond every fixture row, but safely inside the INTEGER bounds
      const [row] = await prisma.$queryRaw`SELECT COALESCE(max(id), 0)::int + 1000000 AS id FROM "StreakReward"`
      return { id: row.id }
    }],
    ['expired reward', async userId => makeCredit(userId, { expiresAt: new Date(Date.now() - DAY_MS) })],
    ['REPLY reward', async userId => makeCredit(userId, { type: 'REPLY' })]
  ])('rejects: %s', async (_label, seed) => {
    const userId = await makeUser()
    const post = await makePost(userId)
    const credit = await seed(userId)

    await expect(redeem(userId, post.id, credit.id)).rejects.toThrow(UNAVAILABLE)
    expect((await readPost(post.id)).promoBoostPiconeros).toBe(0n)
    const stored = await prisma.streakReward.findUnique({ where: { id: credit.id } })
    if (stored) {
      expect(stored.consumedAt).toBeNull()
      expect(stored.itemId).toBeNull()
    }
  })

  test('rejects a credit already consumed on another item', async () => {
    const userId = await makeUser()
    const first = await makePost(userId)
    const second = await makePost(userId)
    const spentElsewhere = await makeCredit(userId, { consumedAt: new Date(), itemId: first.id })

    await expect(redeem(userId, second.id, spentElsewhere.id)).rejects.toThrow(UNAVAILABLE)
    expect((await readPost(second.id)).promoBoostPiconeros).toBe(0n)
    expect(
      await prisma.streakReward.findUnique({ where: { id: spentElsewhere.id } })
    ).toMatchObject({ itemId: first.id, consumedAt: expect.any(Date) })
  })

  test.each([
    ['job', { subNames: ['jobs'] }],
    ['poll', { pollCost: 10, pollExpiresAt: new Date(Date.now() + 7 * DAY_MS) }],
    ['bounty', { bountyPiconeros: '1000000000', bountyStatus: 'FUNDED', bountyConfirmedAt: new Date() }],
    ['paid wall', { moneroWallEnabledAt: new Date(), moneroWallPricePiconeros: '1000000000', moneroWallThresholdPiconeros: '5000000000' }]
  ])('%s posts are eligible', async (_label, fields) => {
    const userId = await makeUser()
    const typed = await makePost(userId, fields)
    const before = await readPost(typed.id)
    const credit = await makeCredit(userId)

    const item = await redeem(userId, typed.id, credit.id)
    expect(item.id).toBe(typed.id)
    const after = await readPost(typed.id)
    // only the promo term (+ the task-2 rank fold) moved: the paid/monetary/vote
    // accounting columns are untouched, same list the accounting suite watches
    expect(after.promoBoostPiconeros).toBe(BOOST_CREDIT_PICONEROS)
    expect(pick(after, ACCOUNTING_FIELDS)).toEqual(pick(before, ACCOUNTING_FIELDS))
    // no wall-unlock or bounty ledger change happened
    expect(after.moneroWallRemovedAt).toBeNull()
    expect(after.bountyPiconeros).toBe(before.bountyPiconeros)
    expect(after.bountyStatus).toBe(before.bountyStatus)
    expect(after.pollCost ?? null).toBe(before.pollCost ?? null)
  })

  test('the registered GraphQL wrapper runs the same META reader (response path + wall gating)', async () => {
    expect(typeof itemResolvers.Mutation.useBoostCredit).toBe('function')
    const userId = await makeUser()
    const post = await makePost(userId, {
      moneroWallEnabledAt: new Date(),
      moneroWallPricePiconeros: '1000000000',
      moneroWallThresholdPiconeros: '5000000000'
    })
    // real posts carry an ITEM_CREATE PayIn; the META reader inner-joins on it,
    // so the fixture wears one to be visible to the response path
    await makeItemCreatePayIn(post.id, userId)
    const credit = await makeCredit(userId)
    const wallBefore = await readPost(post.id)

    const item = await itemResolvers.Mutation.useBoostCredit(null, { itemId: String(post.id), rewardId: String(credit.id) }, {
      me: { id: userId }, models: prisma, headers: {}
    })
    expect(item.id).toBe(post.id)
    expect(item.promoBoostPiconeros).toBe(BOOST_CREDIT_PICONEROS)
    // the response is exactly what the item(id) query would serve
    const direct = await getItem(null, { id: String(post.id) }, { me: { id: userId }, models: prisma })
    expect(item).toEqual(direct)
    // no wall-unlock or other item mutation happened
    const wallAfter = await readPost(post.id)
    expect(wallAfter.moneroWallRemovedAt).toBeNull()
    expect(wallAfter.moneroWallEnabledAt.getTime()).toBe(wallBefore.moneroWallEnabledAt.getTime())
  })

  test('replay never spends a subsequently earned credit', async () => {
    const userId = await makeUser()
    const post = await makePost(userId)
    const first = await makeCredit(userId)
    await redeem(userId, post.id, first.id)
    const second = await makeCredit(userId)
    await prisma.streakReward.update({ where: { id: first.id }, data: { expiresAt: new Date(0) } })
    await redeem(userId, post.id, first.id)
    expect((await readPost(post.id)).promoBoostPiconeros).toBe(500_000_000n)
    expect((await prisma.streakReward.findUnique({ where: { id: second.id } })).consumedAt).toBeNull()
  })

  test('a retry after success does not reapply the promo term', async () => {
    const userId = await makeUser()
    const post = await makePost(userId)
    const credit = await makeCredit(userId)

    await redeem(userId, post.id, credit.id)
    const replayed = await redeem(userId, post.id, credit.id)
    expect(replayed.id).toBe(post.id)
    expect((await readPost(post.id)).promoBoostPiconeros).toBe(BOOST_CREDIT_PICONEROS)
    expect(await prisma.streakReward.count({ where: { id: credit.id, consumedAt: { not: null } } })).toBe(1)
  })

  test('later deletion does not refund, and the retry after it is rejected without reapplying', async () => {
    const userId = await makeUser()
    const post = await makePost(userId)
    const credit = await makeCredit(userId)
    await redeem(userId, post.id, credit.id)
    const boosted = await readPost(post.id)
    expect(boosted.promoBoostPiconeros).toBe(BOOST_CREDIT_PICONEROS)

    await prisma.$executeRaw`UPDATE "Item" SET "deletedAt" = now_utc() WHERE id = ${post.id}::int`
    await expect(redeem(userId, post.id, credit.id)).rejects.toThrow(UNAVAILABLE)
    const after = await readPost(post.id)
    expect(after.deletedAt).not.toBeNull()
    expect(after.promoBoostPiconeros).toBe(BOOST_CREDIT_PICONEROS)
    const reward = await prisma.streakReward.findUnique({ where: { id: credit.id } })
    expect(reward.consumedAt).not.toBeNull()
    expect(reward.itemId).toBe(post.id)
  })

  test('a crash at the rank write rolls back receipt consume and increment atomically', async () => {
    const userId = await makeUser()
    const post = await makePost(userId)
    const credit = await makeCredit(userId)
    const faulty = prisma.$extends({
      query: {
        item: {
          async update () { throw new Error('boom') }
        }
      }
    })

    await expect(useBoostCredit(null, { itemId: String(post.id), rewardId: String(credit.id) }, {
      me: { id: userId },
      models: faulty,
      headers: {},
      readItem: (_, { id }, { models }) => getItemResult(models, { id })
    })).rejects.toThrow('boom')

    const reward = await prisma.streakReward.findUnique({ where: { id: credit.id } })
    expect(reward.consumedAt).toBeNull()
    expect(reward.itemId).toBeNull()
    expect((await readPost(post.id)).promoBoostPiconeros).toBe(0n)

    // the retry on the healthy client then lands exactly once
    await redeem(userId, post.id, credit.id)
    expect((await readPost(post.id)).promoBoostPiconeros).toBe(BOOST_CREDIT_PICONEROS)
  })

  test('Promise.allSettled: two concurrent redemptions of the same credit on the same post both succeed with one increment', async () => {
    const userId = await makeUser()
    const post = await makePost(userId)
    const credit = await makeCredit(userId)

    const settled = await Promise.allSettled([
      redeem(userId, post.id, credit.id),
      redeem(userId, post.id, credit.id)
    ])
    expect(settled.map(r => r.status)).toEqual(['fulfilled', 'fulfilled'])
    expect((await readPost(post.id)).promoBoostPiconeros).toBe(BOOST_CREDIT_PICONEROS)
    const reward = await prisma.streakReward.findUnique({ where: { id: credit.id } })
    expect(reward.consumedAt).not.toBeNull()
    expect(reward.itemId).toBe(post.id)
  })

  test('Promise.allSettled: the same credit raced across two posts yields exactly one success', async () => {
    const userId = await makeUser()
    const postA = await makePost(userId)
    const postB = await makePost(userId)
    const credit = await makeCredit(userId)

    const settled = await Promise.allSettled([
      redeem(userId, postA.id, credit.id),
      redeem(userId, postB.id, credit.id)
    ])
    expect(settled.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = settled.find(r => r.status === 'rejected')
    expect(rejected.reason.message).toBe(UNAVAILABLE)

    const [pa, pb] = await Promise.all([readPost(postA.id), readPost(postB.id)])
    const boosted = [pa, pb].filter(p => p.promoBoostPiconeros === BOOST_CREDIT_PICONEROS)
    expect(boosted).toHaveLength(1)
    const reward = await prisma.streakReward.findUnique({ where: { id: credit.id } })
    expect([postA.id, postB.id]).toContain(reward.itemId)
  })

  test('Promise.allSettled: a concurrent day-5 grant and redemption never leaves two available credits', async () => {
    const userId = await makeUser()
    const post = await makePost(userId)
    const held = await makeCredit(userId)
    const streak = await prisma.streak.create({
      data: { userId, type: 'FLAME', startedAt: new Date('2026-01-01T00:00:00.000Z'), rewardLevel: 4 }
    })
    created.streakIds.push(streak.id)
    await prisma.user.update({ where: { id: userId }, data: { streak: 4 } })

    const settled = await Promise.allSettled([
      advanceQuestStreak({ models: prisma, userId, day: '2026-01-02' }),
      redeem(userId, post.id, held.id)
    ])
    expect(settled.every(r => r.status === 'fulfilled')).toBe(true)

    const rows = await prisma.streakReward.findMany({ where: { userId } })
    const consumed = rows.filter(r => r.consumedAt)
    const available = rows.filter(r => !r.consumedAt && r.expiresAt > new Date())
    expect(consumed).toHaveLength(1)
    expect(consumed[0].itemId).toBe(post.id)
    // the banked cap of one is enforced under the same per-user lock in both orders:
    // at most one credit is ever available, and the reader agrees with the rows
    expect(available.length).toBeLessThanOrEqual(1)
    const read = await availableBoostCredit(prisma, userId)
    expect(read ? [read.id] : []).toEqual(available.map(r => r.id))
  })

  // The property under test: expiry is adjudicated by the wall-clock read
  // taken AFTER all locks (rewardNow → DB time), not by any pre-lock sample.
  // Deterministic shape — the credit is seeded BEFORE the blocker, because the
  // StreakReward INSERT takes FOR KEY SHARE on the users row (FK): seeded
  // behind the held FOR UPDATE it would land already expired and the case
  // would degenerate into the plain expired-reward rejection. Instead the
  // credit is live when the blocker holds the row and redeem enters, its
  // expiresAt passes while the blocker still holds, and only then is the
  // consume adjudicated. If expiry were ever judged from a pre-lock app
  // timestamp at resolver entry, the credit would still look live and the
  // consume would go through, failing this test.
  test('a credit expiring while redeem waits on the user-row lock is unavailable after the blocker releases', async () => {
    const userId = await makeUser()
    const post = await makePost(userId)
    // coupled windows: the blocker must hold past the credit's expiry
    const EXPIRY_DELAY_MS = 500
    const BLOCKER_HOLD_MS = 900
    const expiresAt = new Date(Date.now() + EXPIRY_DELAY_MS)
    const credit = await makeCredit(userId, { expiresAt })

    let resolveLockHeld
    const lockHeld = new Promise(resolve => { resolveLockHeld = resolve })
    const blocker = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${Number(userId)}::int FOR UPDATE`
      resolveLockHeld()
      await sleep(BLOCKER_HOLD_MS)
    })
    await lockHeld

    // expiry passes while the lock is held — which only rules out the plain
    // expired-reward case if the credit was still live when redeem entered
    const enteredAt = Date.now()
    expect(enteredAt).toBeLessThan(expiresAt.getTime())
    const redemption = redeem(userId, post.id, credit.id)
    // give the redemption a chance to reach the parked lock wait, then prove
    // the credit is STILL unexpired while the blocker holds
    await sleep(150)
    expect(Date.now()).toBeLessThan(expiresAt.getTime())

    const [blockerResult] = await Promise.allSettled([blocker, redemption])
    expect(blockerResult.status).toBe('fulfilled')
    await expect(redemption).rejects.toThrow(UNAVAILABLE)

    const reward = await prisma.streakReward.findUnique({ where: { id: credit.id } })
    expect(reward.consumedAt).toBeNull()
    expect(reward.itemId).toBeNull()
    expect((await readPost(post.id)).promoBoostPiconeros).toBe(0n)
    expect(await availableBoostCredit(prisma, userId)).toBeNull()
  })

  test('rejects a valid but nonexistent item without touching the credit', async () => {
    const userId = await makeUser()
    const credit = await makeCredit(userId)
    // an id beyond every fixture row, but safely inside the INTEGER bounds
    const [row] = await prisma.$queryRaw`SELECT COALESCE(max(id), 0)::int + 1000000 AS id FROM "Item"`

    await expect(redeem(userId, row.id, credit.id)).rejects.toThrow(UNAVAILABLE)
    const reward = await prisma.streakReward.findUnique({ where: { id: credit.id } })
    expect(reward.consumedAt).toBeNull()
    expect(reward.itemId).toBeNull()
  })
})

describe('redemption accounting invariants', () => {
  test('the promo term alone moves: monetary, paid and vote accounting stays untouched', async () => {
    const userId = await makeUser()
    const post = await makePost(userId)
    const credit = await makeCredit(userId)

    const ITEM_SELECT = Object.fromEntries(ACCOUNTING_FIELDS.map(f => [f, true]))
    const itemBefore = await prisma.item.findUnique({ where: { id: post.id }, select: ITEM_SELECT })
    const userBefore = await prisma.user.findUnique({
      where: { id: userId }, select: { stackedPiconeros: true, stackedCredits: true }
    })
    const observationsBefore = await prisma.$queryRaw`
      SELECT
        (SELECT count(*) FROM "PayIn" WHERE "userId" = ANY(${[userId]}::int[])) AS pay_ins,
        (SELECT count(*) FROM "ItemPayIn" WHERE "itemId" = ${post.id}::int) AS item_pay_ins,
        (SELECT count(*) FROM "ObservedTip" WHERE "postId" = ${post.id}::int) AS tips,
        (SELECT count(*) FROM "ObservedDownvote" WHERE "postId" = ${post.id}::int) AS downs,
        (SELECT count(*) FROM "FeeObservation" WHERE "postId" = ${post.id}::int) AS fees`

    await redeem(userId, post.id, credit.id)

    expect(await prisma.item.findUnique({ where: { id: post.id }, select: ITEM_SELECT })).toEqual(itemBefore)
    expect(await prisma.user.findUnique({
      where: { id: userId }, select: { stackedPiconeros: true, stackedCredits: true }
    })).toEqual(userBefore)
    const observationsAfter = await prisma.$queryRaw`
      SELECT
        (SELECT count(*) FROM "PayIn" WHERE "userId" = ANY(${[userId]}::int[])) AS pay_ins,
        (SELECT count(*) FROM "ItemPayIn" WHERE "itemId" = ${post.id}::int) AS item_pay_ins,
        (SELECT count(*) FROM "ObservedTip" WHERE "postId" = ${post.id}::int) AS tips,
        (SELECT count(*) FROM "ObservedDownvote" WHERE "postId" = ${post.id}::int) AS downs,
        (SELECT count(*) FROM "FeeObservation" WHERE "postId" = ${post.id}::int) AS fees`
    expect(observationsAfter).toEqual(observationsBefore)
    expect(Object.values(observationsAfter[0]).map(Number).every(n => n === 0)).toBe(true)
  })

  test('promotional Item/StreakReward rows are invisible to the accounting readers', async () => {
    const userId = await makeUser()
    const post = await makePost(userId)
    const credit = await makeCredit(userId)
    await redeem(userId, post.id, credit.id)

    const STAGENET_ADDR = '5AWPhvfMuvWeePRNT192gwa9m63XHdzBmMxfizUhBJedJSqA1Y1BViTETV6uxyCS8Zf8Tz2KKEhHC8FjSRvuDgsd2JuAX6J'
    const SCOPE = { network: 'STAGENET', walletAddress: STAGENET_ADDR }
    const CONFIG = {
      downvoteRewardsPct: 100,
      postingFeeRewardsPct: 70,
      territoryFeeRewardsPct: 30,
      boostRewardsPct: 30,
      walletlessTipRewardsPct: 70
    }

    // Identical ledger fixtures, differing ONLY in the promo tables the readers
    // are free to ignore: if either reader ever consulted Item/StreakReward the
    // two variants would diverge. Keyed to what the caller passes ({ items,
    // rewards }), so the promo rows actually reach the probes. Journal/payout/
    // distribution rows carry the audit snapshot's FULL closed column shape.
    const ledgerFixture = ({ items: promoItemRows = [], rewards: promoRewardRows = [] } = {}) => ({
      account: { id: 1, label: 'platform_rewards', address: STAGENET_ADDR, network: 'STAGENET' },
      payouts: [{ id: 1, distributionId: null, curatorId: null, state: 'SENT', txHash: 'aa'.repeat(32), recipientAddress: '5Aledger', piconeros: 60n }],
      distributions: [{
        id: 1,
        status: null,
        periodStart: null,
        periodEnd: null,
        poolPiconeros: 0n,
        distributedPiconeros: 0n,
        rolledOverPiconeros: 0n,
        payoutCount: 0,
        opsInflowPiconeros: 0n,
        opsRolledOverPiconeros: 0n,
        opsAvailablePiconeros: 0n,
        opsSweptPiconeros: 0n,
        opsSweepState: null,
        opsSweepTxHash: null,
        opsNetworkFeesAccountedPiconeros: 0n
      }],
      transactions: [{
        id: null,
        network: 'STAGENET',
        walletAddress: STAGENET_ADDR,
        txHash: 'bb'.repeat(32),
        kind: 'CONSOLIDATION',
        accountIndex: 0,
        state: 'RELAYED',
        distributionId: null,
        principalPiconeros: 0n,
        networkFeePiconeros: 7n,
        metadata: null,
        preparedAt: null,
        relayAttemptedAt: null,
        relayedAt: null,
        relayProvenance: null,
        dispatchId: null,
        captureContractVersion: null,
        claimDigest: null,
        paymentClaims: null,
        proofId: null
      }],
      audits: [],
      item: { findMany: jest.fn(async () => promoItemRows) },
      streakReward: { findMany: jest.fn(async () => promoRewardRows) }
    })
    const ledgerModels = fixture => ({
      moneroAccount: { findFirst: jest.fn(async () => fixture.account) },
      rewardPayout: { findMany: jest.fn(async () => fixture.payouts) },
      rewardDistribution: { findMany: jest.fn(async () => fixture.distributions) },
      rewardsWalletTransaction: {
        findMany: jest.fn(async () => fixture.transactions),
        findUnique: jest.fn(async () => null)
      },
      rewardsWalletReconciliation: { findMany: jest.fn(async () => fixture.audits) },
      platformFeeConfig: { findUnique: jest.fn(async () => CONFIG) },
      // Audit-snapshot side groups (empty; no bounty/escrow facts in this DB).
      subaddressIndex: { findMany: jest.fn(async () => []) },
      feeObservation: { findMany: jest.fn(async () => []) },
      observedDownvote: { findMany: jest.fn(async () => []) },
      escrowWalletTransaction: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
      bountyPayment: { findMany: jest.fn(async () => []) },
      observedBounty: { findMany: jest.fn(async () => []) },
      observedBountyReceipt: { findMany: jest.fn(async () => []) },
      earn: { findMany: jest.fn(async () => []) },
      paymentTransactionProof: { findUnique: jest.fn(async () => null) },
      // visibility probes for the promotional tables
      item: fixture.item,
      streakReward: fixture.streakReward
    })
    const inflowRow = {
      downvote: 96n,
      posting: 0n,
      territory: 0n,
      donate: 0n,
      donateRaw: 0n,
      boost: 0n,
      walletlesstip: 0n,
      bountyrollover: 0n,
      bountyrolloverRewards: 0n,
      bountyfee: 4n,
      time: new Date('2026-10-12T00:00:00.000Z')
    }
    const inflowModels = promoQueries => ({
      $queryRaw: jest.fn(async (template, ...values) => {
        const sqlText = template.raw.join(' ? ')
        // tripwire: a reader that queried the promo tables would be handed the
        // promotional rows and skew its output against the without-promo read
        if (promoQueries && PROMO_TABLE_IN_SQL.test(sqlText)) return promoQueries
        return [inflowRow]
      })
    })

    const promo = { items: [{ id: post.id, promoBoostPiconeros: 500_000_000n }], rewards: [{ id: credit.id }] }
    const promoInflowModels = inflowModels(promo.rewards)
    const promoLedgerFixture = ledgerFixture(promo)
    const without = {
      inflow: await readRewardsInflow(inflowModels(null), { start: new Date(0), config: CONFIG }),
      ledger: await readRewardsWalletLedger(ledgerModels(ledgerFixture()), { scope: SCOPE })
    }
    const withPromo = {
      inflow: await readRewardsInflow(promoInflowModels, { start: new Date(0), config: CONFIG }),
      ledger: await readRewardsWalletLedger(ledgerModels(promoLedgerFixture), { scope: SCOPE })
    }

    // promotional rows are not money: identical readers' output with and without
    expect(withPromo.inflow).toEqual(without.inflow)
    expect(withPromo.ledger).toEqual(without.ledger)
    // and neither reader ever came near the promotional data. The ledger's
    // promo-table delegates stayed untouched…
    expect(promoLedgerFixture.item.findMany).not.toHaveBeenCalled()
    expect(promoLedgerFixture.streakReward.findMany).not.toHaveBeenCalled()
    // …and the inflow reader did issue its queries, but none of the captured
    // SQL references the promo tables or the promo column
    expect(promoInflowModels.$queryRaw.mock.calls.length).toBeGreaterThan(0)
    for (const call of promoInflowModels.$queryRaw.mock.calls) {
      const sqlText = call[0].raw.join(' ? ')
      expect(PROMO_TABLE_IN_SQL.test(sqlText)).toBe(false)
      expect(/promoBoostPiconeros/i.test(sqlText)).toBe(false)
    }
  })
})

describe('UserPrivates boost credit fields', () => {
  const ROW = { id: 7, expiresAt: new Date('2026-11-04T05:00:00.000Z') }
  const privatesModels = row => ({ $queryRaw: jest.fn(async () => (row ? [row] : [])) })
  const user = { id: 5 }

  test('both fields derive from the same available row', async () => {
    const models = privatesModels(ROW)
    expect(await userResolvers.UserPrivates.boostCreditId(user, {}, { models, me: { id: 5 } })).toBe(7)
    expect(await userResolvers.UserPrivates.boostCreditExpiresAt(user, {}, { models, me: { id: 5 } }))
      .toEqual(ROW.expiresAt)
  })

  test('no credit reads as null on both fields', async () => {
    const models = privatesModels(null)
    expect(await userResolvers.UserPrivates.boostCreditId(user, {}, { models, me: { id: 5 } })).toBeNull()
    expect(await userResolvers.UserPrivates.boostCreditExpiresAt(user, {}, { models, me: { id: 5 } })).toBeNull()
  })

  test('both fields await one memoized availability read per request', async () => {
    // the context object is the per-request cache key (built fresh per request
    // by pages/api/graphql.js): one read serves both fields
    const models = privatesModels(ROW)
    const ctx = { models, me: { id: 5 } }
    expect(await userResolvers.UserPrivates.boostCreditId(user, {}, ctx)).toBe(7)
    expect(await userResolvers.UserPrivates.boostCreditExpiresAt(user, {}, ctx)).toEqual(ROW.expiresAt)
    expect(models.$queryRaw).toHaveBeenCalledTimes(1)
  })

  test('a grant landing between the two field resolutions cannot mix id and expiry', async () => {
    // spec §5.2: both fields resolve from the SAME available-credit reader.
    // The read is taken once at the first field's resolution; a credit landing
    // after it — every LATER read returns the new row — can never surface as
    // an id from the old row with an expiry from the new one.
    const BEFORE = { id: 7, expiresAt: new Date('2026-11-04T05:00:00.000Z') }
    const AFTER = { id: 8, expiresAt: new Date('2026-11-05T05:00:00.000Z') }
    let granted = false
    const models = { $queryRaw: jest.fn(async () => (granted ? [AFTER] : [BEFORE])) }
    const ctx = { models, me: { id: 5 } }
    const id = await userResolvers.UserPrivates.boostCreditId(user, {}, ctx)
    granted = true // the credit lands between the two field resolutions
    const expiry = await userResolvers.UserPrivates.boostCreditExpiresAt(user, {}, ctx)
    expect(id).toBe(7)
    // still the pre-grant row: the second field joined the same memoized read
    expect(expiry).toEqual(BEFORE.expiresAt)
    expect(models.$queryRaw).toHaveBeenCalledTimes(1)
  })

  test.each([
    ['anonymous', undefined],
    ['foreign', { id: 9 }]
  ])('%s privates never query the ledger', async (_label, me) => {
    const models = privatesModels(ROW)
    expect(await userResolvers.UserPrivates.boostCreditId(user, {}, { models, me })).toBeNull()
    expect(await userResolvers.UserPrivates.boostCreditExpiresAt(user, {}, { models, me })).toBeNull()
    expect(models.$queryRaw).not.toHaveBeenCalled()
  })
})
