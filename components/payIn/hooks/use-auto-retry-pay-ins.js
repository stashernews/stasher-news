import { PAY_IN_AUTO_RETRY_TYPES, WALLET_MAX_RETRIES, WALLET_RETRY_BEFORE_MS } from '@/lib/constants'

// The Lightning send-wallet background auto-retry loop (and its cancel/bolt11 plumbing) was
// removed with the Bolt11 surface; Monero failed/pending pay-ins are recovered server-side via
// webhooks and confirmed by the worker. This predicate remains for cache-phase gating.
export function isAutoRetryEligiblePayIn (payIn) {
  if (!payIn || !payIn.payerPrivates) return false

  const {
    payInState,
    payInType,
    payInStateChangedAt,
    payerPrivates: { payInFailureReason, retryCount }
  } = payIn

  return payInState !== 'PAID' &&
    PAY_IN_AUTO_RETRY_TYPES.includes(payInType) &&
    retryCount < WALLET_MAX_RETRIES &&
    new Date(payInStateChangedAt) > new Date(Date.now() - WALLET_RETRY_BEFORE_MS) &&
    payInFailureReason !== 'USER_CANCELLED'
}
