import { PayInState } from '@prisma/client'

export const PAY_IN_TERMINAL_STATES = ['PAID', 'FAILED']
export const PAY_IN_PENDING_STATES = Object.values(PayInState).filter(state => !PAY_IN_TERMINAL_STATES.includes(state))

export async function payInWithdrawalPaid ({ data, models, ...args }) {
  throw new Error('Monero payments not implemented')
}

export async function payInWithdrawalFailed ({ data, models, ...args }) {
  throw new Error('Monero payments not implemented')
}

export async function payInPaid ({ data, models, ...args }) {
  throw new Error('Monero payments not implemented')
}

export async function payInForwarding ({ data, models, boss, lnd, ...args }) {
  throw new Error('Monero payments not implemented')
}

export async function payInForwarded ({ data, models, lnd, boss, ...args }) {
  throw new Error('Monero payments not implemented')
}

export async function payInFailedForward ({ data, models, lnd, boss, ...args }) {
  throw new Error('Monero payments not implemented')
}

export async function payInHeld ({ data, models, lnd, boss, ...args }) {
  throw new Error('Monero payments not implemented')
}

export async function payInCancel ({ data, models, lnd, boss, ...args }) {
  throw new Error('Monero payments not implemented')
}

export async function payInFailed ({ data, models, lnd, boss, ...args }) {
  throw new Error('Monero payments not implemented')
}
