import { BOUNTY_MIN_PICONEROS } from '@/lib/constants'
import { piconerosToXmrDecimal, piconerosToMXmr, piconerosToMXmrDual } from '@/lib/format'

// StasherNews bounty amount + status helpers (A-13 Task 7 UI).
//
// Bounty amounts are stored as piconeros (1e-12 XMR) BigInts server-side. The
// GraphQL BigInt scalar serializes safe integers as JS Numbers, so bounty
// amounts arrive as Numbers for any realistic bounty; bountyPiconerosOf
// normalizes Number/string/BigInt/null to a BigInt for display.

// 0.01 XMR — the client-side floor for the bounty amount input, derived from
// BOUNTY_MIN_PICONEROS so the UI can never drift from the server minimum.
export const BOUNTY_MIN_XMR = Number(piconerosToXmrDecimal(BOUNTY_MIN_PICONEROS))

// Default for the bounty amount input: the floor itself (0.01 XMR), derived
// from BOUNTY_MIN_PICONEROS so the initial value can never fall below the
// server minimum (the form would otherwise pre-fill an amount that fails
// validation).
export const BOUNTY_DEFAULT_XMR = piconerosToXmrDecimal(BOUNTY_MIN_PICONEROS)

// Display-only normalization: null/undefined -> 0n, everything else via Number
// so BigInt(Number(value)) is lossless for any safe-integer piconero amount.
export function bountyPiconerosOf (value) {
  return value == null ? 0n : BigInt(Number(value))
}

// Client-side floor enforcement — mirrors the style of lib/downvote.js
// downvoteAmountError. Returns an error string, or null when valid.
export function bountyAmountError (value) {
  if (value === '' || value == null) return 'required'
  const n = Number(value)
  if (!Number.isFinite(n)) return 'must be a number'
  if (n <= 0) return 'must be positive'
  if (n < BOUNTY_MIN_XMR) return `must be at least ${BOUNTY_MIN_XMR} XMR`
  return null
}

// Human status words for the bounty badge/status line (brief: funded/awarded/
// expired/refunded/rolled over, plus the in-progress and pre-funding states the
// author sees while their bounty is still invisible to others).
const BOUNTY_STATUS_WORDS = {
  UNFUNDED: 'unfunded',
  PENDING_FUNDING: 'funding pending',
  DETECTED: 'funding',
  FUNDED: 'funded',
  EXPIRED: 'expired',
  AWARDED: 'awarded',
  REFUNDED: 'refunded',
  ROLLED_OVER: 'rolled over'
}

export function bountyStatusWord (status) {
  return BOUNTY_STATUS_WORDS[status] || (status || '').toLowerCase().replaceAll('_', ' ')
}

// Scan prompt for the bounty funding modal: state the total (bounty + escrow
// fee) up front, with the breakdown in parentheses.
export function bountyFundingDescription (amountPiconeros, feePiconeros) {
  const amount = BigInt(Number(amountPiconeros))
  const fee = BigInt(Number(feePiconeros))
  return `Scan to send ${piconerosToMXmrDual(amount + fee)} (${piconerosToMXmr(amount)} bounty + ${piconerosToMXmr(fee)} escrow fee) to the bounty escrow.`
}
