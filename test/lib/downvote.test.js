/* eslint-env jest */

import {
  DOWNVOTE_MIN_PICONEROS,
  DOWNVOTE_MAX_PICONEROS,
  DOWNVOTE_LARGE_PICONEROS,
  downvoteAmountError,
  isLargeDownvote
} from '@/lib/downvote'

test('downvote bounds: min 5e8, max 2.5e10, large threshold 1e10', () => {
  expect(DOWNVOTE_MIN_PICONEROS).toBe(500_000_000)
  expect(DOWNVOTE_MAX_PICONEROS).toBe(25_000_000_000)
  expect(DOWNVOTE_LARGE_PICONEROS).toBe(10_000_000_000)
})

test('downvoteAmountError accepts the preset amounts', () => {
  expect(downvoteAmountError(500_000_000)).toBeNull()
  expect(downvoteAmountError(1_000_000_000)).toBeNull()
  expect(downvoteAmountError(5_000_000_000)).toBeNull()
  expect(downvoteAmountError(10_000_000_000)).toBeNull()
  expect(downvoteAmountError(25_000_000_000)).toBeNull()
})

test('downvoteAmountError rejects amounts above the new max', () => {
  expect(downvoteAmountError(25_000_000_001)).toMatch(/at most/)
})

test('isLargeDownvote flags 0.01 XMR and above', () => {
  expect(isLargeDownvote(10_000_000_000)).toBe(true)
  expect(isLargeDownvote(25_000_000_000)).toBe(true)
  expect(isLargeDownvote(1_500_000_000)).toBe(false)
})
