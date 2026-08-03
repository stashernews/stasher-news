/* eslint-env jest */
import { canPostFree, postingFeePiconeros, postingFeePrivatesFor } from '@/api/monero/postingFee'

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

describe('postingFeePrivatesFor', () => {
  test('low-rep self-view reports the floor fee', async () => {
    const result = await postingFeePrivatesFor(
      MODELS,
      { id: 7, stackedPiconeros: 0n, createdAt: new Date() },
      7
    )
    expect(result).toEqual({ postingFeeRequired: true, postingFeePiconeros: 1_000_000_000n, freePostThresholdPiconeros: 10_000_000_000n, freePostMinAgeDays: 7 })
  })

  test('established self-view reports no fee', async () => {
    const now = Date.now()
    const result = await postingFeePrivatesFor(
      MODELS,
      { id: 7, stackedPiconeros: 10_000_000_000n, createdAt: new Date(now - 8 * DAY) },
      7
    )
    expect(result).toEqual({ postingFeeRequired: false, postingFeePiconeros: 0n, freePostThresholdPiconeros: 10_000_000_000n, freePostMinAgeDays: 7 })
  })

  test('other viewers never see fee info', async () => {
    // user id 7 vs viewer id 8: the mismatch guard is what's under test
    const result = await postingFeePrivatesFor(
      MODELS,
      { id: 7, stackedPiconeros: 0n, createdAt: new Date() },
      8
    )
    expect(result).toEqual({ postingFeeRequired: false, postingFeePiconeros: 0n, freePostThresholdPiconeros: 0n, freePostMinAgeDays: 0 })
  })

  test('a logged-out viewer never sees fee info', async () => {
    const result = await postingFeePrivatesFor(
      MODELS,
      { id: 7, stackedPiconeros: 0n, createdAt: new Date() },
      null
    )
    expect(result).toEqual({ postingFeeRequired: false, postingFeePiconeros: 0n, freePostThresholdPiconeros: 0n, freePostMinAgeDays: 0 })
  })

  test('missing config reports no fee', async () => {
    const models = { platformFeeConfig: { findUnique: async () => null } }
    const result = await postingFeePrivatesFor(
      models,
      { id: 7, stackedPiconeros: 0n, createdAt: new Date() },
      7
    )
    expect(result).toEqual({ postingFeeRequired: false, postingFeePiconeros: 0n, freePostThresholdPiconeros: 0n, freePostMinAgeDays: 0 })
  })
})
