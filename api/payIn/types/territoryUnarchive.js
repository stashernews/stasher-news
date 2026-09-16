import { PAID_ACTION_PAYMENT_METHODS, TERRITORY_PERIOD_COST } from '@/lib/constants'
import { nextBilling } from '@/lib/territory'
import { initialTrust, subOccWhere } from '../lib/territory'
import * as MEDIA_UPLOAD from './mediaUpload'
import { territoryFeePiconeros } from '@/api/monero/territoryFee'
import { reserveFeeSubaddress } from '@/api/monero/feePool'
import { buildMoneroUri } from '@/api/monero/uri'
import { GqlInputError } from '@/lib/error'
import { scheduleTerritoryBilling } from '../lib/scheduleTerritoryBilling'
import { uploadFees } from '@/api/resolvers/upload'

export const anonable = false

export const paymentMethods = [
  PAID_ACTION_PAYMENT_METHODS.FEE_CREDIT,
  PAID_ACTION_PAYMENT_METHODS.REWARD_SATS,
  PAID_ACTION_PAYMENT_METHODS.PESSIMISTIC
]

export async function getInitial (models, { billingType, uploadIds = [] }, { me }) {
  const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
  if (!config) throw new GqlInputError('fee config not initialized')
  const fee = territoryFeePiconeros(billingType, config)
  const reserved = await reserveFeeSubaddress(models, 'TERRITORY_UNARCHIVE', { me }) // major 2

  const beneficiaries = []
  let uploadFeesPiconeros = 0n
  if (uploadIds.length > 0) {
    const fees = await uploadFees(uploadIds, { models, me })
    uploadFeesPiconeros = fees.totalFeesPiconeros
    beneficiaries.push(await MEDIA_UPLOAD.getInitial(models, { uploadIds }, { me }))
  }

  const moneroUri = buildMoneroUri(
    [{ address: reserved.address, amount: fee + uploadFeesPiconeros }],
    { description: `StasherNews turf reactivation (${billingType})` }
  )

  return {
    payInType: 'TERRITORY_UNARCHIVE',
    userId: me?.id,
    piconeros: 0n,
    moneroUri,
    moneroSubaddressMajor: reserved.major,
    moneroSubaddressMinor: reserved.minor,
    beneficiaries
  }
}

export async function onBegin (tx, payInId, { name, billingType, uploadIds, ...data }) {
  const payIn = await tx.payIn.findUnique({ where: { id: payInId } })
  const sub = await tx.sub.findUnique({
    where: {
      name
    }
  })

  data.billingCost = TERRITORY_PERIOD_COST(billingType)

  // we never want to bill them again if they are changing to ONCE
  if (billingType === 'ONCE') {
    data.billPaidUntil = null
    data.billingAutoRenew = false
  }

  data.billedLastAt = new Date()
  data.billPaidUntil = nextBilling(data.billedLastAt, billingType)
  data.status = 'ACTIVE'
  data.userId = payIn.userId

  if (sub.userId !== payIn.userId) {
    try {
      // this will throw if this transfer has already happened
      await tx.territoryTransfer.create({ data: { subName: name, oldUserId: sub.userId, newUserId: payIn.userId } })
      // this will throw if the prior user has already unsubscribed
      await tx.subSubscription.delete({ where: { userId_subName: { userId: sub.userId, subName: name } } })
    } catch (e) {
      console.error(e)
    }
  }

  await tx.subSubscription.upsert({
    where: {
      userId_subName: {
        userId: payIn.userId,
        subName: name
      }
    },
    update: {
      userId: payIn.userId,
      subName: name
    },
    create: {
      userId: payIn.userId,
      subName: name
    }
  })

  const updatedSub = await tx.sub.update({
    data: {
      ...data,
      billingStatus: 'PENDING_FEE',
      billingPayInId: payInId,
      billingType,
      subPayIn: { create: [{ payInId }] }
    },
    // optimistic concurrency control
    // make sure none of the relevant fields have changed since we fetched the sub
    where: subOccWhere(sub)
  })

  const trust = await initialTrust(tx, { name: updatedSub.name, userId: updatedSub.userId })
  for (const t of trust) {
    await tx.userSubTrust.upsert({
      where: {
        userId_subName: { userId: t.userId, subName: t.subName }
      },
      update: t,
      create: t
    })
  }

  await scheduleTerritoryBilling(tx, updatedSub.name, updatedSub.billPaidUntil)

  return updatedSub
}

export async function describe (models, payInId) {
  const payIn = await models.payIn.findUnique({ where: { id: payInId }, include: { subPayIn: true, pessimisticEnv: true } })
  const subName = payIn.subPayIn?.subName || payIn.pessimisticEnv?.args?.name
  return `SN: unarchive territory ${subName}`
}
