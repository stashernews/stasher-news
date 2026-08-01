import { createHmac } from 'node:crypto'

// Deterministic payment-ID generator for tip attribution (spec §4.1).
//
// Each tip gets a unique 8-byte (16 hex char) payment ID derived from
// HMAC-SHA256(REWARDS_PID_KEY, "tip:<postId>:<nonce>"), truncated to 8 bytes.
// The nonce is a per-tip random counter (Date.now()) stored on the ObservedTip,
// so the ID is deterministic for a given (postId, nonce) yet unique across tips.
// Mirrors the downvote payment-ID scheme (spec §2.5) for consistency.

export function generateTipPaymentId (postId, nonce) {
  const key = process.env.REWARDS_PID_KEY || 'stealthnews-dev-pid-key'
  const hmac = createHmac('sha256', key)
  hmac.update(`tip:${postId}:${nonce}`)
  return hmac.digest('hex').slice(0, 16)
}

// Deterministic payment-ID generator for downvote penalty attribution
// (spec §3.3). Each downvote pays the platform rewards wallet tagged with a
// unique 8-byte (16 hex char) payment ID derived from
// HMAC-SHA256(REWARDS_PID_KEY, "dv:<postId>:<nonce>"), truncated to 8 bytes.
// The "dv:" prefix keeps downvote IDs disjoint from tip IDs ("tip:") so the
// moneroIndexer (tips) and penaltyIndexer (downvotes) never collide.
export function generateDownvotePaymentId (postId, nonce) {
  const key = process.env.REWARDS_PID_KEY || 'stealthnews-dev-pid-key'
  const hmac = createHmac('sha256', key)
  hmac.update(`dv:${postId}:${nonce}`)
  return hmac.digest('hex').slice(0, 16)
}
