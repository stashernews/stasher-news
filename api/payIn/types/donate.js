import { PAID_ACTION_PAYMENT_METHODS, USER_ID } from '@/lib/constants'
import { piconerosToXmr } from '@/lib/format'

export const anonable = true

export const paymentMethods = [
  PAID_ACTION_PAYMENT_METHODS.FEE_CREDIT,
  PAID_ACTION_PAYMENT_METHODS.REWARD_SATS,
  PAID_ACTION_PAYMENT_METHODS.PESSIMISTIC
]

export async function getInitial (models, { piconeros }, { me }) {
  return {
    payInType: 'DONATE',
    userId: me?.id,
    piconeros,
    payOutCustodialTokens: [
      { payOutType: 'REWARDS_POOL', userId: USER_ID.rewards, mtokens: piconeros, custodialTokenType: 'SATS' }
    ]
  }
}

export async function describe (models, payInId) {
  const payIn = await models.payIn.findUnique({ where: { id: payInId } })
  return `SN: donate ${piconerosToXmr(payIn.piconeros)} to rewards pool`
}
