import { makeIntegratedAddress } from './integratedAddress'
import { generateDownvotePaymentId } from './paymentId'

// Downvote address + payment_id reverse lookup (spec §3.3).
//
// When a user downvotes a post, they pay a fee-sized amount to the platform
// rewards wallet via an *integrated address* (primary rewards address + an
// 8-byte payment_id baked in). The payment_id deterministically encodes the
// (postId, nonce) pair; the rewardsWalletObserver later
// reverses it via reverseMapPaymentId to apply the downvote once the payment
// lands on-chain.

// makeDownvoteAddress(postId, nonce) -> { integratedAddress, paymentId }
//
// Pure: computes the downvote payment_id and folds it into the platform
// rewards primary address as a Monero integrated address. The DownvotePidMap
// row is recorded separately (Task 3's downZap getInitial) — this function
// performs no DB I/O. Throws if PLATFORM_REWARDS_ADDRESS is unset.
export function makeDownvoteAddress (postId, nonce) {
  const primary = process.env.PLATFORM_REWARDS_ADDRESS
  if (!primary) {
    throw new Error('PLATFORM_REWARDS_ADDRESS is not set')
  }
  const paymentId = generateDownvotePaymentId(postId, nonce)
  const { integratedAddress } = makeIntegratedAddress(primary, paymentId)
  return { integratedAddress, paymentId }
}

// reverseMapPaymentId(paymentId, models) -> Promise<row | null>
//
// Looks up the DownvotePidMap row for a detected payment_id. Returns the raw
// row (postId, nonce, userId, expiresAt, consumedAt) or null if no such
// payment_id was ever issued. Expiry/consumed filtering is the rewardsWalletObserver's
// concern, not ours.
export async function reverseMapPaymentId (paymentId, models) {
  return models.downvotePidMap.findUnique({ where: { paymentId } })
}
