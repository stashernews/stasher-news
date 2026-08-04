import { PAID_ACTION_PAYMENT_METHODS } from '@/lib/constants'
import { numWithUnits } from '@/lib/format'

export const anonable = false

export const paymentMethods = [
  PAID_ACTION_PAYMENT_METHODS.REWARD_SATS,
  PAID_ACTION_PAYMENT_METHODS.PESSIMISTIC
]

export async function getInitial (models, { credits }, { me }) {
  return {
    payInType: 'BUY_CREDITS',
    userId: me?.id,
    piconeros: BigInt(credits) * 1000n,
    payOutCustodialTokens: [
      {
        payOutType: 'BUY_CREDITS',
        userId: me.id,
        mtokens: BigInt(credits) * 1000n,
        custodialTokenType: 'CREDITS'
      }
    ]
  }
}

export async function describe (models, payInId) {
  const payIn = await models.payIn.findUnique({ where: { id: payInId } })
  return `SN: buy ${numWithUnits(Number(BigInt(payIn.piconeros) / 1000n), { abbreviate: false, unitSingular: 'credit', unitPlural: 'credits' })}`
}
