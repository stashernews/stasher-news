// StasherNews downvote amount helpers (spec §6.9).
//
// Internal downvote amounts are piconeros (1e-12 XMR). The `act` GraphQL
// mutation carries the amount via its legacy `sats: Int` arg, which the backend
// reinterprets as piconeros (`piconeros: BigInt(sats)`). GraphQL `Int` is signed
// 32-bit, so a single downvote is capped at ~2.147e9 piconeros (~0.0021 XMR);
// DOWNVOTE_MAX_PICONEROS stays safely below that ceiling. The floor and default
// mirror PlatformFeeConfig { downvoteMinPiconeros = 1e8, defaultDownvotePiconeros = 1e9 }.

export const DOWNVOTE_MIN_PICONEROS = 100_000_000 // 1e8  = 0.0001 XMR (floor)
export const DOWNVOTE_DEFAULT_PICONEROS = 1_000_000_000 // 1e9  = 0.001 XMR
export const DOWNVOTE_MAX_PICONEROS = 2_000_000_000 // 2e9  = 0.002 XMR (Int32-safe ceiling)
export const DOWNVOTE_STEP_PICONEROS = 100_000_000 // 1e8  = 0.0001 XMR increments

// "large downvote" warning threshold. The design spec (§6.9) suggests warning
// above 1e10 piconeros (0.01 XMR), but `sats: Int` caps amounts well below that,
// so 1e10 is unreachable today. We warn above a reachable mid-range value
// instead; revisit once the backend moves the amount to a BigInt piconeros arg.
export const DOWNVOTE_LARGE_PICONEROS = 1_500_000_000 // 0.0015 XMR

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
  Number(piconeros) > threshold
