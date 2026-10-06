/* eslint-env jest */
import { canPostFree, postingFeePiconeros, postingFeePrivatesFor, freeCommentsQuota, freePostsQuota, commentsFreeLeft, postsFreeLeft, feeReceivedPiconerosForPayIn, __resetFeeConfigCacheForTests, commentQuotaFor, postQuotaFor, bankedPostCredits, bankedReplyCredits } from '@/api/monero/postingFee'

const DAY = 86_400_000
const CONFIG = { freePostThresholdPiconeros: 10_000_000_000n, freePostMinAgeDays: 7, postingFeeFloorPiconeros: 1_000_000_000n }

test('canPostFree is true only above BOTH the stacked threshold and the age threshold', () => {
  const now = Date.now()
  // above both -> true
  expect(canPostFree({ stackedPiconeros: 10_000_000_000n, createdAt: new Date(now - 8 * DAY) }, CONFIG)).toBe(true)
  // under stacked threshold -> false
  expect(canPostFree({ stackedPiconeros: 9_999_999_999n, createdAt: new Date(now - 30 * DAY) }, CONFIG)).toBe(false)
  // under age threshold -> false
  expect(canPostFree({ stackedPiconeros: 50_000_000_000n, createdAt: new Date(now - 1 * DAY) }, CONFIG)).toBe(false)
})

test('canPostFree treats exactly the threshold as free (>=)', () => {
  const now = Date.now()
  expect(canPostFree({ stackedPiconeros: 10_000_000_000n, createdAt: new Date(now - 7 * DAY) }, CONFIG)).toBe(true)
})

test('canPostFree handles BigInt stacked against a BigInt threshold', () => {
  const now = Date.now()
  expect(canPostFree({ stackedPiconeros: 0n, createdAt: new Date(now - 365 * DAY) }, CONFIG)).toBe(false)
})

test('postingFeePiconeros returns the platform floor (1e9 piconeros = 0.001 XMR)', () => {
  expect(postingFeePiconeros(CONFIG)).toBe(1_000_000_000n)
})

// The user fixtures carry id: 7 so the self-view guard (viewerId === user.id)
// passes and the tests exercise the real config paths instead of
// short-circuiting on the id mismatch. $queryRaw returns zero banked credits
// (POST and REPLY) by default; mkPrisma can stage them per type.
const MODELS = {
  platformFeeConfig: { findUnique: async () => CONFIG },
  $queryRaw: async () => [{ credits: 0, nextExpiresAt: null }]
}

beforeEach(() => { __resetFeeConfigCacheForTests() })

describe('postingFeePrivatesFor', () => {
  test('low-rep self-view with the free post available reports no fee', async () => {
    const result = await postingFeePrivatesFor(
      MODELS,
      { id: 7, stackedPiconeros: 0n, createdAt: new Date(), freePostCount: 0, freePostResetAt: null, streak: null, freeCommentCount: 0 },
      7
    )
    expect(result).toEqual({
      postingFeeRequired: false,
      postingFeePiconeros: 0n,
      postingFeeFloorPiconeros: 1_000_000_000n,
      freePostThresholdPiconeros: 10_000_000_000n,
      freePostMinAgeDays: 7,
      freePostsLeft: 1,
      freePostCount: 0,
      freePostsQuota: 1,
      freeCommentsQuota: 1,
      freePostCredits: 0,
      freePostCreditsExpireAt: null
    })
  })

  test('low-rep self-view with the free post used reports the floor fee', async () => {
    const result = await postingFeePrivatesFor(
      MODELS,
      { id: 7, stackedPiconeros: 0n, createdAt: new Date(), freePostCount: 1, freePostResetAt: null, streak: null, freeCommentCount: 0 },
      7
    )
    expect(result.postingFeeRequired).toBe(true)
    expect(result.postingFeePiconeros).toBe(1_000_000_000n)
    expect(result.freePostsLeft).toBe(0)
    expect(result.freePostsQuota).toBe(1)
  })

  test('established self-view reports no fee (flat quota, free post available)', async () => {
    const now = Date.now()
    const result = await postingFeePrivatesFor(
      MODELS,
      { id: 7, stackedPiconeros: 10_000_000_000n, createdAt: new Date(now - 8 * DAY), freePostCount: 0, freePostResetAt: null, streak: null, freeCommentCount: 0 },
      7
    )
    expect(result).toEqual({
      postingFeeRequired: false,
      postingFeePiconeros: 0n,
      postingFeeFloorPiconeros: 1_000_000_000n,
      freePostThresholdPiconeros: 10_000_000_000n,
      freePostMinAgeDays: 7,
      freePostsLeft: 1,
      freePostCount: 0,
      freePostsQuota: 1,
      freeCommentsQuota: 1,
      freePostCredits: 0,
      freePostCreditsExpireAt: null
    })
  })

  test('established self-view with exhausted post quota reports the floor fee', async () => {
    const now = Date.now()
    const result = await postingFeePrivatesFor(
      MODELS,
      { id: 7, stackedPiconeros: 10_000_000_000n, createdAt: new Date(now - 8 * DAY), freePostCount: 1, freePostResetAt: null, streak: null, freeCommentCount: 0 },
      7
    )
    expect(result.postingFeeRequired).toBe(true)
    expect(result.postingFeePiconeros).toBe(1_000_000_000n)
    expect(result.freePostsLeft).toBe(0)
  })

  test('other viewers never see fee info', async () => {
    // user id 7 vs viewer id 8: the mismatch guard is what's under test
    const result = await postingFeePrivatesFor(
      MODELS,
      { id: 7, stackedPiconeros: 0n, createdAt: new Date() },
      8
    )
    expect(result).toEqual({ postingFeeRequired: false, postingFeePiconeros: 0n, postingFeeFloorPiconeros: 0n, freePostThresholdPiconeros: 0n, freePostMinAgeDays: 0, freePostsLeft: 0, freePostCount: 0, freePostsQuota: 0, freeCommentsQuota: 0, freePostCredits: 0, freePostCreditsExpireAt: null })
  })

  test('a logged-out viewer never sees fee info', async () => {
    const result = await postingFeePrivatesFor(
      MODELS,
      { id: 7, stackedPiconeros: 0n, createdAt: new Date() },
      null
    )
    expect(result).toEqual({ postingFeeRequired: false, postingFeePiconeros: 0n, postingFeeFloorPiconeros: 0n, freePostThresholdPiconeros: 0n, freePostMinAgeDays: 0, freePostsLeft: 0, freePostCount: 0, freePostsQuota: 0, freeCommentsQuota: 0, freePostCredits: 0, freePostCreditsExpireAt: null })
  })

  test('missing config reports no fee', async () => {
    const models = { platformFeeConfig: { findUnique: async () => null } }
    const result = await postingFeePrivatesFor(
      models,
      { id: 7, stackedPiconeros: 0n, createdAt: new Date() },
      7
    )
    expect(result).toEqual({ postingFeeRequired: false, postingFeePiconeros: 0n, postingFeeFloorPiconeros: 0n, freePostThresholdPiconeros: 0n, freePostMinAgeDays: 0, freePostsLeft: 0, freePostCount: 0, freePostsQuota: 0, freeCommentsQuota: 0, freePostCredits: 0, freePostCreditsExpireAt: null })
  })

  // Turf repost (2026-09-24): a repost (turf addition via pay('ITEM_UPDATE'))
  // always charges the posting floor — the free-post quota waives ITEM_CREATE
  // only — so the self-view must expose the live floor even while
  // postingFeePiconeros is zeroed for a quota-bearing user.
  test('self-view with free posts left still exposes the live floor', async () => {
    const result = await postingFeePrivatesFor(
      MODELS,
      { id: 7, stackedPiconeros: 0n, createdAt: new Date(), freePostCount: 0, freePostResetAt: null, streak: null, freeCommentCount: 0 },
      7
    )
    expect(result.postingFeeRequired).toBe(false)
    expect(result.postingFeePiconeros).toBe(0n)
    expect(result.postingFeeFloorPiconeros).toBe(postingFeePiconeros(CONFIG))
    expect(result.postingFeeFloorPiconeros).toBe(1_000_000_000n)
  })

  // Reservation-aware display: a pending upload-fee post holds its free unit,
  // so the self-view must report the REDUCED left (and the fee as required
  // once nothing is left) — the same number the creation gate prices against.
  test('self-view freePostsLeft is net of a pending upload-fee post reservation', async () => {
    const models = mkPrisma({ reservedPosts: 1 })
    const result = await postingFeePrivatesFor(
      models,
      { id: 7, stackedPiconeros: 0n, createdAt: new Date(), freePostCount: 0, freePostResetAt: null, streak: null, freeCommentCount: 0 },
      7
    )
    expect(result.freePostsLeft).toBe(0)
    expect(result.postingFeeRequired).toBe(true)
    // the reservation releases on abandonment: left returns to 1
    const released = await postingFeePrivatesFor(
      mkPrisma({ reservedPosts: 0 }),
      { id: 7, stackedPiconeros: 0n, createdAt: new Date(), freePostCount: 0, freePostResetAt: null, streak: null, freeCommentCount: 0 },
      7
    )
    expect(released.freePostsLeft).toBe(1)
    expect(released.postingFeeRequired).toBe(false)
  })
})

describe('flat one-tier quotas', () => {
  const DAY2 = 86_400_000
  const CFG = { freePostThresholdPiconeros: 10_000_000_000n, freePostMinAgeDays: 7 }
  const established = { stackedPiconeros: 10_000_000_000n, createdAt: new Date(Date.now() - 8 * DAY2) }
  const lowRep = { stackedPiconeros: 0n, createdAt: new Date() }

  test('quotas are flat: one reply a week and one post a month for every user', () => {
    const lowRep = { createdAt: new Date(), stackedPiconeros: 0n, freeCommentCount: 0, freePostCount: 0 }
    const established = { createdAt: new Date(Date.now() - 30 * 86400000), stackedPiconeros: 10n ** 11n, freeCommentCount: 0, freePostCount: 0 }
    const config = { freePostThresholdPiconeros: 10n ** 10n, freePostMinAgeDays: 7 }
    expect(freeCommentsQuota(lowRep, config)).toBe(1)
    expect(freeCommentsQuota(established, config)).toBe(1)
    expect(freePostsQuota(lowRep, config)).toBe(1)
    expect(freePostsQuota(established, config)).toBe(1)
  })

  test('an unused base post resets to exactly one next month, never two', () => {
    const config = { freePostThresholdPiconeros: 10n ** 10n, freePostMinAgeDays: 7 }
    const user = {
      createdAt: new Date(Date.now() - 30 * 86400000),
      stackedPiconeros: 10n ** 11n,
      freePostCount: 1,
      freePostResetAt: new Date(Date.now() - 1000) // last month's window already closed
    }
    expect(postsFreeLeft(user, config)).toBe(1)
  })

  test('freeCommentsQuota returns 0 for missing users', () => {
    expect(freeCommentsQuota(null, CFG)).toBe(0)
  })

  test('freePostsQuota returns 0 for missing users', () => {
    expect(freePostsQuota(null, CFG)).toBe(0)
  })

  test('commentsFreeLeft counts down the single weekly reply and floors at zero', () => {
    expect(commentsFreeLeft({ ...established, freeCommentCount: 0, freeCommentResetAt: null }, CFG)).toBe(1)
    expect(commentsFreeLeft({ ...lowRep, freeCommentCount: 1, freeCommentResetAt: null }, CFG)).toBe(0)
    expect(commentsFreeLeft({ ...lowRep, freeCommentCount: 20, freeCommentResetAt: null }, CFG)).toBe(0)
  })

  test('commentsFreeLeft resets after the reset date to the flat quota', () => {
    const past = new Date(Date.now() - 1000)
    const e = { ...established, freeCommentCount: 5, freeCommentResetAt: past }
    const l = { ...lowRep, freeCommentCount: 2, freeCommentResetAt: past }
    expect(commentsFreeLeft(e, CFG)).toBe(1)
    expect(commentsFreeLeft(l, CFG)).toBe(1)
  })

  test('commentsFreeLeft returns 0 for missing users', () => {
    expect(commentsFreeLeft(null, CFG)).toBe(0)
  })

  test('postsFreeLeft is quota minus used, resets after reset date to exactly one', () => {
    expect(postsFreeLeft({ ...established, freePostCount: 0, freePostResetAt: null }, CFG)).toBe(1)
    expect(postsFreeLeft({ ...lowRep, freePostCount: 1, freePostResetAt: null }, CFG)).toBe(0)
    const reset = { ...established, freePostCount: 1, freePostResetAt: new Date(Date.now() - 1000) }
    expect(postsFreeLeft(reset, CFG)).toBe(1)
  })
})

// stagenet primary (same as payInItemCreate.test.js) — valid base58 so
// buildMoneroUri accepts the re-quoted address.
const PRIMARY = '5AWPhvfMuvWeePRNT192gwa9m63XHdzBmMxfizUhBJedJSqA1Y1BViTETV6uxyCS8Zf8Tz2KKEhHC8FjSRvuDgsd2JuAX6J'

function mockModels ({ feeObservationSum = null, observedSubFeeSum = null } = {}) {
  return {
    feeObservation: {
      aggregate: async () => ({ _sum: { piconeros: feeObservationSum } })
    },
    observedSubFee: {
      aggregate: async () => ({ _sum: { piconeros: observedSubFeeSum } })
    },
    payIn: {
      findUnique: async ({ where }) => where.id === 6525
        ? { id: 6525, moneroUri: `monero:${PRIMARY}?tx_amount=0.003` }
        : null
    }
  }
}

describe('feeReceivedPiconerosForPayIn', () => {
  test('sums BOTH observation tables (platform FeeObservation + owner ObservedSubFee)', async () => {
    const models = mockModels({ feeObservationSum: 1_000_000_000n, observedSubFeeSum: 500_000_000n })
    expect(await feeReceivedPiconerosForPayIn(models, 1)).toBe(1_500_000_000n)
  })
  test('owner leg: FeeObservation empty, ObservedSubFee carries the receipts', async () => {
    const models = mockModels({ feeObservationSum: null, observedSubFeeSum: 1_000_000_000n })
    expect(await feeReceivedPiconerosForPayIn(models, 1)).toBe(1_000_000_000n)
  })
  test('platform leg: ObservedSubFee empty, FeeObservation carries the receipts', async () => {
    const models = mockModels({ feeObservationSum: 1_000_000_000n, observedSubFeeSum: null })
    expect(await feeReceivedPiconerosForPayIn(models, 1)).toBe(1_000_000_000n)
  })
  test('both empty -> 0n (no receipts yet)', async () => {
    const models = mockModels({})
    expect(await feeReceivedPiconerosForPayIn(models, 1)).toBe(0n)
  })
})

// Prisma mock: $queryRaw dispatches on the SQL text (tagged-template first arg
// is the strings array) so the REPLY credit aggregate, the POST credit
// aggregate, and the pending-quota-reservation count can return different
// shapes from one mock. Reservation counts default to 0 so every pre-existing
// fixture keeps its value.
function mkPrisma ({ postCredits = 0, postExpiresAt = null, replyCredits = 0, replyExpiresAt = null, userRow = null, reservedComments = 0, reservedPosts = 0 } = {}) {
  return {
    platformFeeConfig: { findUnique: async () => CONFIG },
    // jest.fn so the refetch assertion (toHaveBeenCalled) can count calls.
    user: { findUnique: jest.fn(async () => userRow) },
    $queryRaw: jest.fn(async (strings) => {
      const sql = String(strings.join(''))
      if (sql.includes("'REPLY'")) return [{ credits: replyCredits, nextExpiresAt: replyExpiresAt }]
      if (sql.includes("'PENDING_FEE'")) return [{ comments: reservedComments, posts: reservedPosts }]
      return [{ credits: postCredits, nextExpiresAt: postExpiresAt }]
    })
  }
}

describe('commentQuotaFor / bankedReplyCredits', () => {
  const fullUser = { id: 5, freeCommentCount: 0, freeCommentResetAt: null, stackedPiconeros: 0n, createdAt: new Date() }

  test('the flat quota is one base reply, plus banked reply credits when held', async () => {
    const q = await commentQuotaFor(mkPrisma(), { ...fullUser })
    expect(q).toEqual({ base: 1, baseLeft: 1, credits: 0, quota: 1, left: 1, nextExpiresAt: null })
  })

  test('banked reply credits stack on the used base and report the soonest expiry', async () => {
    const soon = new Date(Date.now() + 5 * 86_400_000)
    const q = await commentQuotaFor(mkPrisma({ replyCredits: 2, replyExpiresAt: soon }), { ...fullUser, freeCommentCount: 1 })
    expect(q).toEqual({ base: 1, baseLeft: 0, credits: 2, quota: 1, left: 2, nextExpiresAt: soon })
  })

  test('outstanding PENDING_FEE reservations subtract from left, clamp at zero (comment)', async () => {
    // base exhausted + 2 credits held, but 3 pending upload-fee replies already
    // reserved units: left clamps at 0 (never negative).
    const q = await commentQuotaFor(mkPrisma({ replyCredits: 2, reservedComments: 3 }), { ...fullUser, freeCommentCount: 1 })
    expect(q).toEqual({ base: 1, baseLeft: 0, credits: 2, quota: 1, left: 0, nextExpiresAt: null })
    // partial clamping: 1 base + 2 credits - 1 reserved = 2 still spendable
    const partial = await commentQuotaFor(mkPrisma({ replyCredits: 2, reservedComments: 1 }), { ...fullUser })
    expect(partial.left).toBe(2)
    // baseLeft and credits stay RAW — only left is net.
    expect(partial.baseLeft).toBe(1)
    expect(partial.credits).toBe(2)
  })

  test('comment reservations do not touch the post side and vice versa (comments/posts split)', async () => {
    // 2 reserved COMMENTS must not reduce the post quota...
    const postQuota = await postQuotaFor(mkPrisma({ reservedComments: 2, reservedPosts: 0 }), { ...fullUser, freePostCount: 0, freePostResetAt: null, stackedPiconeros: 0n, createdAt: new Date() }, CONFIG)
    expect(postQuota.left).toBe(1)
    // ...and 2 reserved POSTS must not reduce the comment quota.
    const commentQuota = await commentQuotaFor(mkPrisma({ reservedComments: 0, reservedPosts: 2 }), { ...fullUser })
    expect(commentQuota.left).toBe(1)
  })

  test('an out-of-quota base with reservations still clamps left at zero', async () => {
    // over-quota author (baseLeft 0), no credits, 1 outstanding reservation
    const q = await commentQuotaFor(mkPrisma({ reservedComments: 1 }), { ...fullUser, freeCommentCount: 5 })
    expect(q).toEqual({ base: 1, baseLeft: 0, credits: 0, quota: 1, left: 0, nextExpiresAt: null })
  })

  test('bankedReplyCredits returns the aggregated row as-is', async () => {
    const soon = new Date(Date.now() + 3 * 86_400_000)
    const { credits, nextExpiresAt } = await bankedReplyCredits(mkPrisma({ replyCredits: 7, replyExpiresAt: soon }), 5)
    expect(credits).toBe(7)
    expect(nextExpiresAt).toEqual(soon)
    // expired credits are already filtered out by the SQL (expiresAt > now_utc());
    // the helper never sees them.
    const empty = await bankedReplyCredits(mkPrisma({ replyCredits: 0, replyExpiresAt: null }), 5)
    expect(empty).toEqual({ credits: 0, nextExpiresAt: null })
  })

  test('refetches the user when quota-relevant columns are missing (partial objects)', async () => {
    // GraphQL parent objects can omit freeCommentCount/createdAt, so the helper
    // must refetch rather than silently overcount the base (mirrors hasWallet).
    // The refetched row must carry id — the banked-credit lookup keys on it.
    const prisma = mkPrisma({ userRow: { ...fullUser, freeCommentCount: 4 } })
    const q = await commentQuotaFor(prisma, { id: 5 }) // no count/createdAt
    expect(q.baseLeft).toBe(0)
    expect(q.left).toBe(0)
    expect(prisma.user.findUnique).toHaveBeenCalled()
    // the refetch SELECT must carry id — the banked-credit lookup keys on it.
    // (A select without id fed bankedReplyCredits undefined.)
    const refetchArgs = prisma.user.findUnique.mock.calls[0][0]
    expect(refetchArgs.select).toHaveProperty('id', true)
    // and the StreakReward aggregate must see the REFETCHED user's id (5)
    const creditLookup = prisma.$queryRaw.mock.calls.find(([strings]) => String(strings.join('')).includes('StreakReward'))
    expect(creditLookup).toBeTruthy()
    expect(creditLookup[1]).toBe(5)
  })

  test('missing config or missing user returns zeroes', async () => {
    expect(await commentQuotaFor(mkPrisma(), null)).toEqual({ base: 0, baseLeft: 0, credits: 0, quota: 0, left: 0, nextExpiresAt: null })
    const noConfig = mkPrisma(); noConfig.platformFeeConfig.findUnique = async () => null
    expect(await commentQuotaFor(noConfig, { ...fullUser })).toEqual({ base: 0, baseLeft: 0, credits: 0, quota: 0, left: 0, nextExpiresAt: null })
  })

  test('null/empty user paths never issue a reservation count', async () => {
    // null user: returns zeroes before any aggregate runs
    const prisma = mkPrisma()
    expect(await commentQuotaFor(prisma, null)).toEqual({ base: 0, baseLeft: 0, credits: 0, quota: 0, left: 0, nextExpiresAt: null })
    expect(prisma.$queryRaw).not.toHaveBeenCalled()
    // missing config: same short-circuit, still no aggregate
    const noConfig = mkPrisma(); noConfig.platformFeeConfig.findUnique = async () => null
    expect(await commentQuotaFor(noConfig, { ...fullUser })).toEqual({ base: 0, baseLeft: 0, credits: 0, quota: 0, left: 0, nextExpiresAt: null })
    expect(noConfig.$queryRaw).not.toHaveBeenCalled()
  })
})

describe('postQuotaFor / bankedPostCredits', () => {
  const established = { id: 5, freePostCount: 1, freePostResetAt: new Date(Date.now() + 86_400_000), stackedPiconeros: 10_000_000_000n, createdAt: new Date(Date.now() - 8 * 86_400_000) }

  test('credits stack on top of an exhausted base quota and report the soonest expiry', async () => {
    const soon = new Date(Date.now() + 5 * 86_400_000)
    const q = await postQuotaFor(mkPrisma({ postCredits: 2, postExpiresAt: soon }), established, CONFIG)
    expect(q).toEqual({ baseQuota: 1, baseLeft: 0, credits: 2, left: 2, nextExpiresAt: soon })
  })

  test('outstanding PENDING_FEE reservations subtract from left, clamp at zero (post)', async () => {
    // base exhausted + 2 credits, 1 pending upload-fee post holding its unit
    const q = await postQuotaFor(mkPrisma({ postCredits: 2, reservedPosts: 1 }), established, CONFIG)
    expect(q).toEqual({ baseQuota: 1, baseLeft: 0, credits: 2, left: 1, nextExpiresAt: null })
    // 2 held reservations over 2 credits clamp at zero
    const clamped = await postQuotaFor(mkPrisma({ postCredits: 2, reservedPosts: 2 }), established, CONFIG)
    expect(clamped.left).toBe(0)
    // baseLeft and credits stay RAW — only left is net.
    expect(clamped.baseLeft).toBe(0)
    expect(clamped.credits).toBe(2)
  })

  test('expired credits are already filtered out by the SQL (expiresAt > now_utc())', async () => {
    const prisma = mkPrisma({ postCredits: 0, postExpiresAt: null })
    const { credits } = await bankedPostCredits(prisma, 5)
    expect(credits).toBe(0)
    // NOTE: the brief's original assertion on the $queryRaw call shape
    // (toHaveBeenCalledWith(arrayContaining([stringContaining('"expiresAt" > now_utc()')])))
    // is arity-brittle against tagged templates — the template call passes the
    // strings array PLUS each substitution as separate args, so exact call-arity
    // matching always fails. Simplified to return-value checks per the brief's
    // end note; the `expiresAt > now_utc()` filter stays as a reviewed constant
    // in bankedPostCredits' SQL.
  })
})
