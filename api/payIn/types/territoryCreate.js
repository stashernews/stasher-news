import { PAID_ACTION_PAYMENT_METHODS, TERRITORY_PERIOD_COST } from '@/lib/constants'
import { nextBilling } from '@/lib/territory'
import { initialTrust } from '../lib/territory'
import { territoryFeePiconeros } from '@/api/monero/territoryFee'
import { reserveFeeSubaddress } from '@/api/monero/feePool'
import { buildMoneroUri } from '@/api/monero/uri'
import { scheduleTerritoryBilling } from '../lib/scheduleTerritoryBilling'

// StasherNews territory creation (spec §6.2). The founder pays a territory fee to
// the platform rewards wallet via a dedicated major-2 subaddress; the territory is
// created billingStatus=PENDING_FEE (invisible/inactive) until the rewardsWalletObserver
// observes the fee and flips it to PAID. piconeros=0 (no custodial sats) so the SN
// payIn engine yields payInState=PAID; the fee itself is on-chain.

export const anonable = false

export const paymentMethods = [
  PAID_ACTION_PAYMENT_METHODS.FEE_CREDIT,
  PAID_ACTION_PAYMENT_METHODS.REWARD_SATS,
  PAID_ACTION_PAYMENT_METHODS.PESSIMISTIC
]

export async function getInitial (models, { billingType, name }, { me }) {
  const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
  const fee = territoryFeePiconeros(billingType, config)
  const sub = await reserveFeeSubaddress(models, 'TERRITORY_CREATE') // major 2
  const moneroUri = buildMoneroUri(
    [{ address: sub.address, amount: fee }],
    { description: `StasherNews territory ${name} (${billingType})` }
  )
  return {
    payInType: 'TERRITORY_CREATE',
    userId: me?.id,
    piconeros: 0n,
    moneroUri,
    moneroSubaddressMajor: sub.major,
    moneroSubaddressMinor: sub.minor
  }
}

export async function onBegin (tx, payInId, { billingType, uploadIds, ...data }) {
  const payIn = await tx.payIn.findUnique({ where: { id: payInId } })
  const billedLastAt = new Date()
  const billPaidUntil = nextBilling(billedLastAt, billingType)

  const sub = await tx.sub.create({
    data: {
      ...data,
      billedLastAt,
      billPaidUntil,
      billingCost: TERRITORY_PERIOD_COST(billingType), // vestigial SN sats field
      billingType,
      billingStatus: 'PENDING_FEE',
      billingPayInId: payInId,
      rankingType: 'WOT',
      userId: payIn.userId,
      subPayIn: {
        create: [{ payInId }]
      },
      SubSubscription: {
        create: {
          userId: payIn.userId
        }
      }
    }
  })

  await tx.userSubTrust.createMany({
    data: initialTrust({ name: sub.name, userId: sub.userId })
  })

  await scheduleTerritoryBilling(tx, sub.name, sub.billPaidUntil)

  return sub
}

export async function describe (models, payInId) {
  const payIn = await models.payIn.findUnique({ where: { id: payInId }, include: { subPayIn: true, pessimisticEnv: true } })
  const subName = payIn.subPayIn?.subName || payIn.pessimisticEnv?.args?.name
  return `SN: create territory ${subName}`
}
