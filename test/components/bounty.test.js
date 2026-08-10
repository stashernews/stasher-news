/* eslint-env jest */
import {
  BOUNTY_MIN_XMR,
  bountyAmountError,
  bountyPiconerosOf,
  bountyStatusWord
} from '@/lib/bounty'
import { BOUNTY_MIN_PICONEROS } from '@/lib/constants'

// There is no React component test harness in this repo (no @testing-library
// setup), so per the repo convention (see downvote-modal.test.js) we test the
// extracted amount/status helpers — the real behavior the form and badge
// enforce — rather than forcing a snapshot harness.

describe('bounty min amount (derived from BOUNTY_MIN_PICONEROS)', () => {
  test('the UI floor is 0.001 XMR', () => {
    expect(BOUNTY_MIN_XMR).toBe(0.001)
  })

  test('the UI floor tracks the server constant', () => {
    expect(BigInt(Math.round(BOUNTY_MIN_XMR * 1e12))).toBe(BOUNTY_MIN_PICONEROS)
  })
})

describe('bountyAmountError floor enforcement', () => {
  test('rejects amounts below the 0.001 XMR floor', () => {
    expect(bountyAmountError(0.0009)).toMatch(/at least/)
    expect(bountyAmountError(0)).toMatch(/positive/)
    expect(bountyAmountError(-1)).toMatch(/positive/)
  })

  test('accepts the floor exactly and typical amounts', () => {
    expect(bountyAmountError(0.001)).toBeNull()
    expect(bountyAmountError(0.5)).toBeNull()
    expect(bountyAmountError('1')).toBeNull()
  })

  test('rejects empty / non-numeric values', () => {
    expect(bountyAmountError('')).toBe('required')
    expect(bountyAmountError(null)).toBe('required')
    expect(bountyAmountError(undefined)).toBe('required')
    expect(bountyAmountError('abc')).toMatch(/number/)
    expect(bountyAmountError(Infinity)).toMatch(/number/)
  })
})

describe('bountyPiconerosOf normalization', () => {
  test('null/undefined -> 0n', () => {
    expect(bountyPiconerosOf(null)).toBe(0n)
    expect(bountyPiconerosOf(undefined)).toBe(0n)
  })

  test('Number and BigInt pass through', () => {
    expect(bountyPiconerosOf(1_000_000_000)).toBe(1_000_000_000n)
    expect(bountyPiconerosOf(1_000_000_000n)).toBe(1_000_000_000n)
  })
})

describe('bountyStatusWord', () => {
  test('maps every BountyStatus enum value to a display word', () => {
    expect(bountyStatusWord('UNFUNDED')).toBe('unfunded')
    expect(bountyStatusWord('PENDING_FUNDING')).toBe('funding pending')
    expect(bountyStatusWord('DETECTED')).toBe('funding')
    expect(bountyStatusWord('FUNDED')).toBe('funded')
    expect(bountyStatusWord('EXPIRED')).toBe('expired')
    expect(bountyStatusWord('AWARDED')).toBe('awarded')
    expect(bountyStatusWord('REFUNDED')).toBe('refunded')
    expect(bountyStatusWord('ROLLED_OVER')).toBe('rolled over')
  })

  test('falls back to a lowercased un-underscored status', () => {
    expect(bountyStatusWord('SOME_FUTURE_STATE')).toBe('some future state')
    expect(bountyStatusWord(undefined)).toBe('')
  })
})
