import { PAID_ACTION_PAYMENT_METHODS, TERRITORY_PERIOD_COST } from '@/lib/constants'
import { nextBilling } from '@/lib/territory'
import { territoryFeePiconeros } from '@/api/monero/territoryFee'
import { reserveFeeSubaddress } from '@/api/monero/feePool'
import { buildMoneroUri } from '@/api/monero/uri'
import * as MEDIA_UPLOAD from './mediaUpload'
import { scheduleTerritoryBilling } from '../lib/scheduleTerritoryBilling'

export const anonable = false

export const paymentMethods = [
  PAID_ACTION_PAYMENT_METHODS.FEE_CREDIT,
  PAID_ACTION_PAYMENT_METHODS.REWARD_SATS,
  PAID_ACTION_PAYMENT_METHODS.PESSIMISTIC
]

// A cadence switch is a paid action only when it moves to a longer/once plan
// (monthly→yearly, *→once). Downgrades (yearly→monthly) are free and simply
// take effect when the paid year ends.
export function needsCadenceFee (oldSub, newBillingType) {
  if (!oldSub || oldSub.billingType === newBillingType) return false
  return newBillingType === 'YEARLY' || newBillingType === 'ONCE'
}

export async function getInitial (models, { oldName, billingType, uploadIds }, { me }) {
  const oldSub = await models.sub.findUnique({
    where: {
      name: oldName
    }
  })

  const beneficiaries = []
  if (uploadIds.length > 0) {
    beneficiaries.push(await MEDIA_UPLOAD.getInitial(models, { uploadIds }, { me }))
  }

  const prospect = {
    payInType: 'TERRITORY_UPDATE',
    userId: me?.id,
    piconeros: 0n,
    beneficiaries
  }

  // cadence switch to a longer/once plan: charge the FULL new fee on-chain at the
  // switch; the new period starts at the end of the current paid coverage so the
  // remaining days are never double-charged (spec §4b).
  if (needsCadenceFee(oldSub, billingType)) {
    const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
    const fee = territoryFeePiconeros(billingType, config)
    const reserved = await reserveFeeSubaddress(models, 'TERRITORY_UPDATE') // major 2
    prospect.moneroUri = buildMoneroUri(
      [{ address: reserved.address, amount: fee }],
      { description: `StealthNews turf ${oldSub.name} switch to ${billingType}` }
    )
    prospect.moneroSubaddressMajor = reserved.major
    prospect.moneroSubaddressMinor = reserved.minor
  }

  return prospect
}

export async function onBegin (tx, payInId, { oldName, billingType, uploadIds, ...data }) {
  const payIn = await tx.payIn.findUnique({ where: { id: payInId } })
  const oldSub = await tx.sub.findUnique({
    where: {
      name: oldName
    }
  })

  data.billingCost = TERRITORY_PERIOD_COST(billingType) // vestigial SN sats field

  const cadenceFee = needsCadenceFee(oldSub, billingType)

  // we never want to bill them again if they are changing to ONCE
  if (billingType === 'ONCE') {
    data.billPaidUntil = null
    data.billingAutoRenew = false
  } else if (cadenceFee) {
    // the new period starts at the end of the current paid coverage (or now if
    // the coverage has lapsed), so the remaining days are never double-charged
    const base = oldSub.billPaidUntil && new Date(oldSub.billPaidUntil) > new Date()
      ? new Date(oldSub.billPaidUntil)
      : new Date()
    data.billPaidUntil = nextBilling(base, billingType)
  }
  // yearly -> monthly: billPaidUntil stays; monthly billing begins once the
  // paid year ends (the territoryBilling worker picks up the new billingType)

  // if this billing change makes their bill paid up, set them to active
  if (data.billPaidUntil === null || data.billPaidUntil >= new Date()) {
    data.status = 'ACTIVE'
  }

  if (cadenceFee) {
    data.billingStatus = 'PENDING_FEE'
    data.billingPayInId = payInId
  }

  const updatedSub = await tx.sub.update({
    data: {
      ...data,
      billingType,
      subPayIn: {
        create: [{ payInId }]
      }
    },
    where: {
      // optimistic concurrency control
      // make sure none of the relevant fields have changed since we fetched the sub
      ...oldSub,
      postTypes: {
        equals: oldSub.postTypes
      },
      name: oldName,
      userId: payIn.userId
    }
  })

  await scheduleTerritoryBilling(tx, updatedSub.name, updatedSub.billPaidUntil)

  return updatedSub
}

export async function describe (models, payInId) {
  const payIn = await models.payIn.findUnique({ where: { id: payInId }, include: { subPayIn: true, pessimisticEnv: true } })
  const subName = payIn.subPayIn?.subName || payIn.pessimisticEnv?.args?.name
  return `SN: update territory billing ${subName}`
}
