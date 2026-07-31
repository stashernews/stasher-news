/* eslint-env jest */
import { canPostFree, postingFeePiconeros } from '@/api/monero/postingFee'

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
