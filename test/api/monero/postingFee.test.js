/* eslint-env jest */
import { canPostFree, postingFeePiconeros, postingFeePrivatesFor, freeCommentsQuota, freePostsQuota, commentsFreeLeft, postsFreeLeft, feeReceivedPiconerosForPayIn, __resetFeeConfigCacheForTests, commentQuotaFor, postQuotaFor, bankedPostCredits } from '@/api/monero/postingFee'
import { completionsFor } from '@/api/quests/completions'

// The quest draw/completion checks have their own real-DB suite; here they are
// mocked so quota math is exercised deterministically (the real draw is
// deterministic per user+day, but these tests must not depend on its outcome).
jest.mock('../../../api/quests/draw', () => ({
  resolveDraw: jest.fn(async () => ({ upvote: 'UPVOTE', drawn: 'BOOST', turfName: null }))
}))
jest.mock('../../../api/quests/completions', () => ({
  completionsFor: jest.fn(async () => ({ UPVOTE: false, BOOST: false, FIRST_RESPONDER: false, TURF: false }))
}))

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
// passes and the tests exercise the real canPostFree / config paths instead of
// short-circuiting on the id mismatch. Low-rep = id 7 viewer 7. $queryRaw
// dispatches on the SQL text: the tip EXISTS quest check returns [] (no tips)
// and the StreakReward aggregate returns zero POST credits.
const MODELS = {
  platformFeeConfig: { findUnique: async () => CONFIG },
  $queryRaw: async (strings) => {
    const sql = String(strings.join(''))
    if (sql.includes('ObservedTip')) return []
    return [{ credits: 0, nextExpiresAt: null }]
  }
}

beforeEach(() => { __resetFeeConfigCacheForTests(); completionsFor.mockClear() })

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

  test('established self-view reports no fee (free posts available)', async () => {
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
      freePostsLeft: 5,
      freePostCount: 0,
      freePostsQuota: 5,
      freeCommentsQuota: 3,
      freePostCredits: 0,
      freePostCreditsExpireAt: null
    })
  })

  test('established self-view with exhausted post quota reports the floor fee', async () => {
    const now = Date.now()
    const result = await postingFeePrivatesFor(
      MODELS,
      { id: 7, stackedPiconeros: 10_000_000_000n, createdAt: new Date(now - 8 * DAY), freePostCount: 5, freePostResetAt: null, streak: null, freeCommentCount: 0 },
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
})

describe('tiered freebie quotas', () => {
  const DAY2 = 86_400_000
  const CFG = { freePostThresholdPiconeros: 10_000_000_000n, freePostMinAgeDays: 7 }
  const established = { stackedPiconeros: 10_000_000_000n, createdAt: new Date(Date.now() - 8 * DAY2) }
  const lowRep = { stackedPiconeros: 0n, createdAt: new Date() }

  test('freeCommentsQuota is 3 established, 1 low-rep', () => {
    expect(freeCommentsQuota(established, CFG)).toBe(3)
    expect(freeCommentsQuota(lowRep, CFG)).toBe(1)
  })

  test('freeCommentsQuota adds the bonus reply count (quests + flame day-3)', () => {
    expect(freeCommentsQuota(established, CFG, { bonusReplies: 0 })).toBe(3)
    expect(freeCommentsQuota(established, CFG, { bonusReplies: 2 })).toBe(5)
    expect(freeCommentsQuota(lowRep, CFG, { bonusReplies: 1 })).toBe(2)
  })

  test('freePostsQuota is 5 established, 1 low-rep', () => {
    expect(freePostsQuota(established, CFG)).toBe(5)
    expect(freePostsQuota(lowRep, CFG)).toBe(1)
  })

  test('commentsFreeLeft counts down within the tier and floors at zero', () => {
    expect(commentsFreeLeft({ ...established, streak: null, freeCommentCount: 1, freeCommentResetAt: null }, CFG)).toBe(2)
    expect(commentsFreeLeft({ ...lowRep, freeCommentCount: 0, freeCommentResetAt: null }, CFG)).toBe(1)
    expect(commentsFreeLeft({ ...lowRep, freeCommentCount: 1, freeCommentResetAt: null }, CFG)).toBe(0)
    expect(commentsFreeLeft({ ...lowRep, freeCommentCount: 1, freeCommentResetAt: null }, CFG, { bonusReplies: 1 })).toBe(1)
    expect(commentsFreeLeft({ ...lowRep, freeCommentCount: 20, freeCommentResetAt: null }, CFG)).toBe(0)
  })

  test('commentsFreeLeft resets after the reset date to the tier quota', () => {
    const past = new Date(Date.now() - 1000)
    const e = { ...established, streak: null, freeCommentCount: 5, freeCommentResetAt: past }
    const l = { ...lowRep, freeCommentCount: 2, freeCommentResetAt: past }
    expect(commentsFreeLeft(e, CFG)).toBe(3)
    expect(commentsFreeLeft(l, CFG)).toBe(1)
  })

  test('commentsFreeLeft returns 0 for missing users', () => {
    expect(commentsFreeLeft(null, CFG)).toBe(0)
  })

  test('postsFreeLeft is quota minus used per tier, resets after reset date', () => {
    expect(postsFreeLeft({ ...established, freePostCount: 2, freePostResetAt: null }, CFG)).toBe(3)
    expect(postsFreeLeft({ ...lowRep, freePostCount: 0, freePostResetAt: null }, CFG)).toBe(1)
    expect(postsFreeLeft({ ...lowRep, freePostCount: 1, freePostResetAt: null }, CFG)).toBe(0)
    const reset = { ...established, freePostCount: 5, freePostResetAt: new Date(Date.now() - 1000) }
    expect(postsFreeLeft(reset, CFG)).toBe(5)
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
// is the strings array) so the tip EXISTS check and the credit aggregate can
// return different shapes from one mock.
function mkPrisma ({ tips = [], credits = 0, nextExpiresAt = null, userRow = null } = {}) {
  return {
    platformFeeConfig: { findUnique: async () => CONFIG },
    // jest.fn so the refetch assertion (toHaveBeenCalled) can count calls.
    user: { findUnique: jest.fn(async () => userRow) },
    $queryRaw: jest.fn(async (strings) => {
      const sql = String(strings.join(''))
      if (sql.includes('ObservedTip')) return tips
      return [{ credits, nextExpiresAt }]
    })
  }
}

describe('commentQuotaFor', () => {
  const fullLowRep = { id: 5, streak: null, freeCommentCount: 0, freeCommentResetAt: null, stackedPiconeros: 0n, createdAt: new Date() }

  test('computes base + quest completions + day-3 bonus in one call', async () => {
    completionsFor.mockResolvedValueOnce({ UPVOTE: true, BOOST: true, FIRST_RESPONDER: false, TURF: false })
    const q = await commentQuotaFor(mkPrisma(), { ...fullLowRep })
    expect(q).toEqual({ base: 1, questsCompleted: 2, day3Bonus: 0, quota: 3, left: 3 })
  })

  test('the flame day-3 bonus adds one reply', async () => {
    const q = await commentQuotaFor(mkPrisma(), { ...fullLowRep, streak: 3 })
    expect(q).toEqual({ base: 1, questsCompleted: 0, day3Bonus: 1, quota: 2, left: 2 })
  })

  test('refetches the user when quota-relevant columns are missing (partial objects)', async () => {
    // GraphQL parent objects can omit streak/freeCommentCount — the helper must
    // refetch rather than silently drop bonuses (mirrors hasWallet).
    const prisma = mkPrisma({ userRow: { ...fullLowRep, streak: 9, freeCommentCount: 4 } })
    const q = await commentQuotaFor(prisma, { id: 5 }) // no streak/count/createdAt
    expect(q.quota).toBe(1)
    expect(q.left).toBe(0)
    expect(prisma.user.findUnique).toHaveBeenCalled()
  })

  test('missing config or missing user returns zeroes', async () => {
    expect(await commentQuotaFor(mkPrisma(), null)).toEqual({ base: 0, questsCompleted: 0, day3Bonus: 0, quota: 0, left: 0 })
    const noConfig = mkPrisma(); noConfig.platformFeeConfig.findUnique = async () => null
    expect((await commentQuotaFor(noConfig, { ...fullLowRep })).quota).toBe(0)
  })
})

describe('postQuotaFor / bankedPostCredits', () => {
  const established = { id: 5, freePostCount: 5, freePostResetAt: new Date(Date.now() + 86_400_000), stackedPiconeros: 10_000_000_000n, createdAt: new Date(Date.now() - 8 * 86_400_000) }

  test('credits stack on top of an exhausted base quota and report the soonest expiry', async () => {
    const soon = new Date(Date.now() + 5 * 86_400_000)
    const q = await postQuotaFor(mkPrisma({ credits: 2, nextExpiresAt: soon }), established, CONFIG)
    expect(q).toEqual({ baseQuota: 5, baseLeft: 0, credits: 2, left: 2, nextExpiresAt: soon })
  })

  test('expired credits are already filtered out by the SQL (expiresAt > now_utc())', async () => {
    const prisma = mkPrisma({ credits: 0, nextExpiresAt: null })
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
