import { PAID_ACTION_PAYMENT_METHODS } from '@/lib/constants'

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
// { threshold, excess, maxFeePiconeros, piconeros } or null when the user is not eligible right now.
export function computeAutoWithdrawAmount (user) {
  if (
    user.autoWithdrawThreshold === null ||
    user.autoWithdrawMaxFeePercent === null ||
    user.autoWithdrawMaxFeeTotal === null) return null

  const threshold = BigInt(user.autoWithdrawThreshold) * 1000n
  const excess = Number(user.stackedPiconeros - threshold)

  // excess must be greater than 10% of threshold
  if (excess < Number(threshold) * 0.1) return null

  // floor fee to nearest sat but still denominated in piconeros
  const maxFeePiconeros = BigInt(Math.floor(Math.max(
    Math.ceil(excess * (user.autoWithdrawMaxFeePercent / 100.0)),
    Number(BigInt(user.autoWithdrawMaxFeeTotal) * 1000n)
  ) / 1000) * 1000)
  // piconeros will be floored by createInvoice if it needs to be
  const piconeros = BigInt(excess) - maxFeePiconeros

  // must be >= 100000 piconeros
  if (piconeros < 100000n) return null

  return { threshold, excess: BigInt(excess), maxFeePiconeros, piconeros }
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
