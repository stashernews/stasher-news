import { PAID_ACTION_PAYMENT_METHODS } from '@/lib/constants'
import { satsToMsats, numWithUnits, msatsToSats } from '@/lib/format'

export const anonable = false

export const paymentMethods = [
  PAID_ACTION_PAYMENT_METHODS.REWARD_SATS
]

export async function getInitial (models, { bolt11, maxFee, protocolId }, { me }) {
  throw new Error('Monero payments not implemented')
}

export async function describe (models, payInId) {
  throw new Error('Monero payments not implemented')
}
