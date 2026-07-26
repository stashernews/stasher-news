import { PAID_ACTION_PAYMENT_METHODS } from '@/lib/constants'

export const anonable = false

export const paymentMethods = [
  PAID_ACTION_PAYMENT_METHODS.REWARD_SATS
]

export async function getInitial (models, { invoice, maxFee, protocolId }, { me }) {
  throw new Error('Monero payments not implemented')
}

export async function describe (models, payInId) {
  throw new Error('Monero payments not implemented')
}
