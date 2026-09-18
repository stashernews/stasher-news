/* eslint-env jest */
import {
  DOWNVOTE_MIN_PICONEROS,
  DOWNVOTE_DEFAULT_PICONEROS,
  DOWNVOTE_MAX_PICONEROS,
  DOWNVOTE_LARGE_PICONEROS,
  downvoteAmountError,
  isLargeDownvote
} from '@/lib/downvote'

jest.mock('../../components/editor', () => ({
  __esModule: true,
  SNEditor: 'textarea'
}))

// There is no React component test harness in this repo (no test/components dir,
// no @testing-library setup), so per the task brief we test the extracted
// amount-validation helpers — the real behavior the slider enforces — rather
// than forcing a snapshot harness. These mirror lib/validate.js lnAddrAmountError.

describe('downvote amount floor enforcement', () => {
  test('the floor is 1e8 piconeros (0.0001 XMR)', () => {
    expect(DOWNVOTE_MIN_PICONEROS).toBe(100_000_000)
  })

  test('rejects amounts below the 1e8 floor', () => {
    expect(downvoteAmountError(DOWNVOTE_MIN_PICONEROS - 1)).not.toBeNull()
    expect(downvoteAmountError(0)).not.toBeNull()
    expect(downvoteAmountError(99_999_999)).toMatch(/at least/)
  })

  test('accepts the floor exactly', () => {
    expect(downvoteAmountError(DOWNVOTE_MIN_PICONEROS)).toBeNull()
  })

  test('accepts the default (1e9) and typical amounts', () => {
    expect(downvoteAmountError(DOWNVOTE_DEFAULT_PICONEROS)).toBeNull()
    expect(downvoteAmountError(500_000_000)).toBeNull()
  })
})

describe('downvote amount ceiling (Int32-safe)', () => {
  test('rejects amounts above the max', () => {
    expect(downvoteAmountError(DOWNVOTE_MAX_PICONEROS + 1)).not.toBeNull()
    expect(downvoteAmountError(DOWNVOTE_MAX_PICONEROS + 1)).toMatch(/at most/)
  })

  test('accepts the max exactly', () => {
    expect(downvoteAmountError(DOWNVOTE_MAX_PICONEROS)).toBeNull()
  })

  test('respects a custom min/max override', () => {
    // simulate a server config with a higher floor (e.g. 5e8)
    expect(downvoteAmountError(100_000_000, { min: 500_000_000 })).not.toBeNull()
    expect(downvoteAmountError(500_000_000, { min: 500_000_000 })).toBeNull()
  })
})

describe('downvote amount shape validation', () => {
  test('rejects empty / non-integer / non-positive', () => {
    expect(downvoteAmountError('')).toBe('required')
    expect(downvoteAmountError(null)).toBe('required')
    expect(downvoteAmountError(undefined)).toBe('required')
    expect(downvoteAmountError(1.5)).toMatch(/whole number/)
    expect(downvoteAmountError(-100)).toMatch(/positive/)
  })
})

describe('isLargeDownvote', () => {
  test('false below the threshold', () => {
    expect(isLargeDownvote(DOWNVOTE_DEFAULT_PICONEROS)).toBe(false)
    expect(isLargeDownvote(DOWNVOTE_LARGE_PICONEROS - 1)).toBe(false)
  })

  test('true at/above the threshold', () => {
    expect(isLargeDownvote(DOWNVOTE_LARGE_PICONEROS)).toBe(true)
    expect(isLargeDownvote(DOWNVOTE_MAX_PICONEROS)).toBe(true)
  })
})
