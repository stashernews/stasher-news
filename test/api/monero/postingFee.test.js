/* eslint-env jest */
import { canPostFree, postingFeePiconeros, postingFeePrivatesFor, freeCommentsQuota, freePostsQuota, commentsFreeLeft, postsFreeLeft, feeReceivedPiconerosForPayIn, __resetFeeConfigCacheForTests } from '@/api/monero/postingFee'

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
// short-circuiting on the id mismatch. Low-rep = id 7 viewer 7.
const MODELS = { platformFeeConfig: { findUnique: async () => CONFIG } }

beforeEach(() => __resetFeeConfigCacheForTests())

describe('postingFeePrivatesFor', () => {
  test('low-rep self-view with the free post available reports no fee', async () => {
    const result = await postingFeePrivatesFor(
      MODELS,
      { id: 7, stackedPiconeros: 0n, createdAt: new Date(), freePostCount: 0, freePostResetAt: null },
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
      freeCommentsQuota: 1
    })
  })

  test('low-rep self-view with the free post used reports the floor fee', async () => {
    const result = await postingFeePrivatesFor(
      MODELS,
      { id: 7, stackedPiconeros: 0n, createdAt: new Date(), freePostCount: 1, freePostResetAt: null },
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
      { id: 7, stackedPiconeros: 10_000_000_000n, createdAt: new Date(now - 8 * DAY), freePostCount: 0, freePostResetAt: null },
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
      freeCommentsQuota: 3
    })
  })

  test('established self-view with exhausted post quota reports the floor fee', async () => {
    const now = Date.now()
    const result = await postingFeePrivatesFor(
      MODELS,
      { id: 7, stackedPiconeros: 10_000_000_000n, createdAt: new Date(now - 8 * DAY), freePostCount: 5, freePostResetAt: null },
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
    expect(result).toEqual({ postingFeeRequired: false, postingFeePiconeros: 0n, postingFeeFloorPiconeros: 0n, freePostThresholdPiconeros: 0n, freePostMinAgeDays: 0, freePostsLeft: 0, freePostCount: 0, freePostsQuota: 0, freeCommentsQuota: 0 })
  })

  test('a logged-out viewer never sees fee info', async () => {
    const result = await postingFeePrivatesFor(
      MODELS,
      { id: 7, stackedPiconeros: 0n, createdAt: new Date() },
      null
    )
    expect(result).toEqual({ postingFeeRequired: false, postingFeePiconeros: 0n, postingFeeFloorPiconeros: 0n, freePostThresholdPiconeros: 0n, freePostMinAgeDays: 0, freePostsLeft: 0, freePostCount: 0, freePostsQuota: 0, freeCommentsQuota: 0 })
  })

  test('missing config reports no fee', async () => {
    const models = { platformFeeConfig: { findUnique: async () => null } }
    const result = await postingFeePrivatesFor(
      models,
      { id: 7, stackedPiconeros: 0n, createdAt: new Date() },
      7
    )
    expect(result).toEqual({ postingFeeRequired: false, postingFeePiconeros: 0n, postingFeeFloorPiconeros: 0n, freePostThresholdPiconeros: 0n, freePostMinAgeDays: 0, freePostsLeft: 0, freePostCount: 0, freePostsQuota: 0, freeCommentsQuota: 0 })
  })

  // Turf repost (2026-09-24): a repost (turf addition via pay('ITEM_UPDATE'))
  // always charges the posting floor — the free-post quota waives ITEM_CREATE
  // only — so the self-view must expose the live floor even while
  // postingFeePiconeros is zeroed for a quota-bearing user.
  test('self-view with free posts left still exposes the live floor', async () => {
    const result = await postingFeePrivatesFor(
      MODELS,
      { id: 7, stackedPiconeros: 0n, createdAt: new Date(), freePostCount: 0, freePostResetAt: null },
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

  test('freePostsQuota is 5 established, 1 low-rep', () => {
    expect(freePostsQuota(established, CFG)).toBe(5)
    expect(freePostsQuota(lowRep, CFG)).toBe(1)
  })

  test('commentsFreeLeft counts down within the tier and floors at zero', () => {
    expect(commentsFreeLeft({ ...established, freeCommentCount: 1, freeCommentResetAt: null }, CFG)).toBe(2)
    expect(commentsFreeLeft({ ...lowRep, freeCommentCount: 0, freeCommentResetAt: null }, CFG)).toBe(1)
    expect(commentsFreeLeft({ ...lowRep, freeCommentCount: 20, freeCommentResetAt: null }, CFG)).toBe(0)
  })

  test('commentsFreeLeft resets after the reset date to the tier quota', () => {
    const e = { ...established, freeCommentCount: 5, freeCommentResetAt: new Date(Date.now() - 1000) }
    expect(commentsFreeLeft(e, CFG)).toBe(3)
    const l = { ...lowRep, freeCommentCount: 2, freeCommentResetAt: new Date(Date.now() - 1000) }
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
