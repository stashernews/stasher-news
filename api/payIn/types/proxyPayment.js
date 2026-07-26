import { PAID_ACTION_PAYMENT_METHODS } from '@/lib/constants'
import { toPositiveBigInt } from '@/lib/format'
import { notifyDeposit } from '@/lib/webPush'

export const anonable = false

// P2P payments removed - Monero integration pending
export const paymentMethods = []

export async function getInitial (models, { msats, description, descriptionHash, expiry }, { me }) {
  throw new Error('Monero payments not implemented')
}

export async function onBegin (tx, payInId, { comment, lud18Data, noteStr }) {
  throw new Error('Monero payments not implemented')
}

export async function onPaid (tx, payInId) {
  throw new Error('Monero payments not implemented')
}

export async function onPaidSideEffects (models, payInId) {
  throw new Error('Monero payments not implemented')
}

export async function describe (models, payInId) {
  throw new Error('Monero payments not implemented')
}
