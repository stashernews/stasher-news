import { createHmac } from 'node:crypto'

const DEFAULT_PID_KEY = 'stashernews-dev-pid-key'

// Resolve the HMAC key used to mint payment-Id capability tokens. Fail-closed
// when the weak committed dev-default is still in use in production OR on
// mainnet: tipStatus exposes paymentId as an UNAUTHENTICATED capability token,
// and with the default key the (public, sequential) postId + Date.now() nonce
// become brute-forceable. The public VPS runs NODE_ENV=production on stagenet,
// so gating on mainnet alone never fired there. Non-production non-mainnet
// keeps the dev default so local/stagenet stacks boot without config.
// (lib/env.js additionally enforces presence/non-default at boot via
// PROD_REQUIRED/PROD_MUST_DIFFER.)
function resolveRewardsPidKey () {
  const key = process.env.REWARDS_PID_KEY || DEFAULT_PID_KEY
  if (key === DEFAULT_PID_KEY &&
      (process.env.NODE_ENV === 'production' || process.env.MONERO_NETWORK === 'mainnet')) {
    throw new Error('REWARDS_PID_KEY must be set to a non-default value in production (and on mainnet)')
  }
  return key
}

// Deterministic payment-ID generator for tip attribution (spec §4.1).
//
// Each tip gets a unique 8-byte (16 hex char) payment ID derived from
// HMAC-SHA256(REWARDS_PID_KEY, "tip:<postId>:<nonce>"), truncated to 8 bytes.
// The nonce is a random 8-byte hex value minted by the caller and is NOT
// persisted — the derived paymentId is what's stored on the ObservedTip —
// so the ID is deterministic for a given (postId, nonce) yet unique across tips.
// Mirrors the downvote payment-ID scheme (spec §2.5) for consistency.

export function generateTipPaymentId (postId, nonce) {
  const key = resolveRewardsPidKey()
  const hmac = createHmac('sha256', key)
  hmac.update(`tip:${postId}:${nonce}`)
  return hmac.digest('hex').slice(0, 16)
}

// Deterministic payment-ID generator for downvote attribution
// (spec §3.3). Each downvote pays the platform rewards wallet tagged with a
// unique 8-byte (16 hex char) payment ID derived from
// HMAC-SHA256(REWARDS_PID_KEY, "dv:<postId>:<nonce>"), truncated to 8 bytes.
// The "dv:" prefix keeps downvote IDs disjoint from tip IDs ("tip:") so the
// tip and downvote ID namespaces never collide (tips arrive via lws webhooks;
// rewardsWalletObserver attributes downvotes).
export function generateDownvotePaymentId (postId, nonce) {
  const key = resolveRewardsPidKey()
  const hmac = createHmac('sha256', key)
  hmac.update(`dv:${postId}:${nonce}`)
  return hmac.digest('hex').slice(0, 16)
}

// Deterministic payment-ID generator for bounty funding attribution (A-13).
// Each funding gets a unique 8-byte (16 hex char) payment ID derived from
// HMAC-SHA256(REWARDS_PID_KEY, "bn:<postId>:<nonce>"), truncated to 8 bytes.
// The nonce is a random 63-bit integer (int8-safe) stored on the
// BountyPidMap, so the ID is
// deterministic for a given (postId, nonce) yet unique across fundings. The
// "bn:" prefix keeps bounty IDs disjoint from tip ("tip:") and downvote
// ("dv:") IDs so lws webhook callbacks are attributed to exactly one flow.
export function generateBountyPaymentId (postId, nonce) {
  const key = resolveRewardsPidKey()
  const hmac = createHmac('sha256', key)
  hmac.update(`bn:${postId}:${nonce}`)
  return hmac.digest('hex').slice(0, 16)
}

// Deterministic payment-ID generator for owner-routed turf fees/boosts.
// HMAC-SHA256(REWARDS_PID_KEY, "fee:<seed>:<nonce>"), truncated to 8 bytes.
// The seed is a randomUUID minted per leg (the PayIn id does not exist yet at
// getInitial time); the nonce is Date.now(). The "fee:" prefix keeps fee IDs
// disjoint from tip ("tip:"), downvote ("dv:"), and bounty ("bn:") namespaces
// so webhook callbacks attribute to exactly one flow.
export function generateSubFeePaymentId (seed, nonce) {
  const key = resolveRewardsPidKey()
  const hmac = createHmac('sha256', key)
  hmac.update(`fee:${seed}:${nonce}`)
  return hmac.digest('hex').slice(0, 16)
}
