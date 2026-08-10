import { createHmac } from 'node:crypto'

const DEFAULT_PID_KEY = 'stashernews-dev-pid-key'

// Resolve the HMAC key used to mint payment-Id capability tokens. Fail-closed on
// mainnet when the weak committed dev-default is still in use: tipStatus exposes
// paymentId as an UNAUTHENTICATED capability token, and with the default key the
// (public, sequential) postId + Date.now() nonce become brute-forceable. Non-
// mainnet keeps the dev default so local/stagenet stacks boot without config.
function resolveRewardsPidKey () {
  const key = process.env.REWARDS_PID_KEY || DEFAULT_PID_KEY
  if (process.env.MONERO_NETWORK === 'mainnet' && key === DEFAULT_PID_KEY) {
    throw new Error('REWARDS_PID_KEY must be set to a non-default value on mainnet')
  }
  return key
}

// Deterministic payment-ID generator for tip attribution (spec §4.1).
//
// Each tip gets a unique 8-byte (16 hex char) payment ID derived from
// HMAC-SHA256(REWARDS_PID_KEY, "tip:<postId>:<nonce>"), truncated to 8 bytes.
// The nonce is a per-tip random counter (Date.now()) stored on the ObservedTip,
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
// The nonce is Date.now() stored on the BountyPidMap, so the ID is
// deterministic for a given (postId, nonce) yet unique across fundings. The
// "bn:" prefix keeps bounty IDs disjoint from tip ("tip:") and downvote
// ("dv:") IDs so lws webhook callbacks are attributed to exactly one flow.
export function generateBountyPaymentId (postId, nonce) {
  const key = resolveRewardsPidKey()
  const hmac = createHmac('sha256', key)
  hmac.update(`bn:${postId}:${nonce}`)
  return hmac.digest('hex').slice(0, 16)
}
