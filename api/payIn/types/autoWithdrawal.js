import { PAID_ACTION_PAYMENT_METHODS } from '@/lib/constants'
import { msatsSatsFloor, satsToMsats } from '@/lib/format'

export const anonable = false

export const paymentMethods = [
  PAID_ACTION_PAYMENT_METHODS.REWARD_SATS
]

export class AutoWithdrawIneligibleError extends Error {
  constructor (message) {
    super(message)
    this.name = 'AutoWithdrawIneligibleError'
  }
}

// Single source of truth for the autowithdraw amount + eligibility arithmetic. Returns
// { threshold, excess, maxFeeMsats, msats } or null when the user is not eligible right now.
export function computeAutoWithdrawAmount (user) {
  if (
    user.autoWithdrawThreshold === null ||
    user.autoWithdrawMaxFeePercent === null ||
    user.autoWithdrawMaxFeeTotal === null) return null

  const threshold = satsToMsats(user.autoWithdrawThreshold)
  const excess = Number(user.msats - threshold)

  // excess must be greater than 10% of threshold
  if (excess < Number(threshold) * 0.1) return null

  // floor fee to nearest sat but still denominated in msats
  const maxFeeMsats = msatsSatsFloor(Math.max(
    Math.ceil(excess * (user.autoWithdrawMaxFeePercent / 100.0)),
    Number(satsToMsats(user.autoWithdrawMaxFeeTotal))
  ))
  // msats will be floored by createInvoice if it needs to be
  const msats = BigInt(excess) - maxFeeMsats

  // must be >= 100000 msats (100 sats)
  if (msats < 100000n) return null

  return { threshold, excess: BigInt(excess), maxFeeMsats, msats }
}

// Monero integration pending - autowithdraw disabled
export async function getInitial (models, args, { me }) {
  throw new Error('Monero payments not implemented')
}

export async function validateBeforeCreate (tx, payInProspect, args, { me }) {
  throw new Error('Monero payments not implemented')
}

export async function describe (models, payInId) {
  throw new Error('Monero payments not implemented')
}
