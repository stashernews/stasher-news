// StasherNews downvote amount helpers (spec §6.9).
//
// Internal downvote amounts are piconeros (1e-12 XMR). The `act` GraphQL
// mutation carries the amount via its `piconeros: BigInt` arg, so amounts far
// beyond 32-bit are fine. The floor and default mirror PlatformFeeConfig
// { downvoteMinPiconeros = 1e8, defaultDownvotePiconeros = 1e9 }; the max
// matches the top tip preset (0.025 XMR).

export const DOWNVOTE_MIN_PICONEROS = 100_000_000 // 1e8  = 0.0001 XMR (floor)
export const DOWNVOTE_DEFAULT_PICONEROS = 1_000_000_000 // 1e9  = 0.001 XMR
export const DOWNVOTE_MAX_PICONEROS = 25_000_000_000 // 2.5e10 = 0.025 XMR (top tip preset)
export const DOWNVOTE_STEP_PICONEROS = 100_000_000 // 1e8  = 0.0001 XMR increments

// "large downvote" warning threshold. The design spec (§6.9) suggests warning
// above 1e10 piconeros (0.01 XMR).
export const DOWNVOTE_LARGE_PICONEROS = 10_000_000_000 // 0.01 XMR

// floor/max enforcement — mirrors the style of lib/validate.js lnAddrAmountError.
// returns an error string, or null when the amount is valid.
export function downvoteAmountError (value, { min = DOWNVOTE_MIN_PICONEROS, max = DOWNVOTE_MAX_PICONEROS } = {}) {
  if (value === '' || value == null) return 'required'
  const n = Number(value)
  if (!Number.isSafeInteger(n)) return 'must be a whole number'
  if (n <= 0) return 'must be positive'
  if (n < min) return `must be at least ${min.toLocaleString()} piconeros`
  if (n > max) return `must be at most ${max.toLocaleString()} piconeros`
  return null
}

export const isLargeDownvote = (piconeros, threshold = DOWNVOTE_LARGE_PICONEROS) =>
  Number(piconeros) >= threshold
