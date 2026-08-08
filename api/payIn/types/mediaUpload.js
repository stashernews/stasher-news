import { PAID_ACTION_PAYMENT_METHODS } from '@/lib/constants'
import { throwOnExpiredUploads } from '@/api/resolvers/upload'

// MEDIA_UPLOAD is only ever a beneficiary of other payIns. The fee itself lives
// in the BENEFACTOR's moneroUri (the benefactor reads it from uploadFees and
// folds it into its URI amount); this beneficiary carries piconeros 0n so the
// engine marks it PAID at creation. onPaid is a deliberate no-op: Upload.paid is
// flipped in worker/rewardsWalletObserver.js (flipPendingToLive) when the
// covering fee is actually observed on the rewards wallet — flipping at attach
// time would mark uploads paid without any fee being paid (dummy-post evasion:
// attach a >10MB upload to a never-paid post, reuse the URL → free).

export const anonable = false

export const paymentMethods = [
  PAID_ACTION_PAYMENT_METHODS.FEE_CREDIT,
  PAID_ACTION_PAYMENT_METHODS.REWARD_SATS,
  PAID_ACTION_PAYMENT_METHODS.PESSIMISTIC
]

export async function getInitial (models, { uploadIds }, { me }) {
  await throwOnExpiredUploads(uploadIds, { tx: models })
  return {
    payInType: 'MEDIA_UPLOAD',
    userId: me?.id,
    piconeros: 0n,
    payOutCustodialTokens: [],
    uploadPayIns: uploadIds.map(id => ({ uploadId: id }))
  }
}

export async function onBegin (tx, payInId, { uploadIds }, benefactorResult) {
  // associate this payIns with the same rows as the benefactor
  const { benefactor } = await tx.payIn.findUnique({
    where: { id: payInId },
    include: { benefactor: { include: { itemPayIn: true, subPayIn: true } } }
  })
  if (benefactor.itemPayIn) {
    await tx.itemPayIn.create({ data: { itemId: benefactor.itemPayIn.itemId, payInId } })
  }
  if (benefactor.subPayIn) {
    await tx.subPayIn.create({ data: { subName: benefactor.subPayIn.subName, payInId } })
  }
}

export async function onPaid () {
  // No-op by design (see header): the fork's engine creates every moneroUri fee
  // payIn as PAID at creation, so onPaid fires at ATTACH time — before the fee
  // is observed on-chain. Flipping Upload.paid here would permanently fee-exempt
  // any upload merely attached to a post. The flip happens in
  // worker/rewardsWalletObserver.js's flipPendingToLive when the covering fee is
  // observed. Kept as an empty function because the engine calls onPaid on every
  // beneficiary through the recursive loop in api/payIn/index.js (the optional
  // call contract).
}
