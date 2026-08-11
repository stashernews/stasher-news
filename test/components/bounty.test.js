/* eslint-env jest */
import {
  BOUNTY_DEFAULT_XMR,
  BOUNTY_MIN_XMR,
  bountyAmountError,
  bountyFundingDescription,
  bountyPiconerosOf,
  bountyStatusWord
} from '@/lib/bounty'
import { BOUNTY_MIN_PICONEROS } from '@/lib/constants'
import { xmrToPiconeros } from '@/lib/format'

// There is no React component test harness in this repo (no @testing-library
// setup), so per the repo convention (see downvote-modal.test.js) we test the
// extracted amount/status helpers — the real behavior the form and badge
// enforce — rather than forcing a snapshot harness.

describe('bounty min amount (derived from BOUNTY_MIN_PICONEROS)', () => {
  test('the UI floor is 0.01 XMR', () => {
    expect(BOUNTY_MIN_XMR).toBe(0.01)
  })

  test('the UI floor tracks the server constant', () => {
    expect(BigInt(Math.round(BOUNTY_MIN_XMR * 1e12))).toBe(BOUNTY_MIN_PICONEROS)
  })
})

describe('bounty default amount', () => {
  test('defaults to the floor (0.01 XMR) so the initial value passes validation', () => {
    expect(BOUNTY_DEFAULT_XMR).toBe('0.01')
  })

  test('the default tracks the server constant', () => {
    expect(xmrToPiconeros(BOUNTY_DEFAULT_XMR)).toBe(BOUNTY_MIN_PICONEROS)
  })
})

describe('bountyAmountError floor enforcement', () => {
  test('rejects amounts below the 0.01 XMR floor', () => {
    expect(bountyAmountError(0.009)).toMatch(/at least/)
    expect(bountyAmountError(0)).toMatch(/positive/)
    expect(bountyAmountError(-1)).toMatch(/positive/)
  })

  test('accepts the floor exactly and typical amounts', () => {
    expect(bountyAmountError(0.01)).toBeNull()
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

describe('bountyFundingDescription', () => {
  test('states the total with the breakdown in parentheses', () => {
    expect(bountyFundingDescription(10_000_000_000n, 10_000_000_000n))
      .toBe('Scan to send 0.02 XMR (0.01 XMR bounty + 0.01 XMR escrow fee) to the bounty escrow.')
  })

  test('handles amounts without a fee floor rounding', () => {
    expect(bountyFundingDescription(5_000_000_000n, 10_000_000_000n))
      .toBe('Scan to send 0.015 XMR (0.005 XMR bounty + 0.01 XMR escrow fee) to the bounty escrow.')
  })

  test('accepts string and number inputs like the GraphQL scalars deliver', () => {
    expect(bountyFundingDescription('10000000000', '10000000000'))
      .toBe('Scan to send 0.02 XMR (0.01 XMR bounty + 0.01 XMR escrow fee) to the bounty escrow.')
    expect(bountyFundingDescription(10000000000, 10000000000))
      .toBe('Scan to send 0.02 XMR (0.01 XMR bounty + 0.01 XMR escrow fee) to the bounty escrow.')
  })
})
