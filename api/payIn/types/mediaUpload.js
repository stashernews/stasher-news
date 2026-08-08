import { PAID_ACTION_PAYMENT_METHODS } from '@/lib/constants'
import { throwOnExpiredUploads } from '@/api/resolvers/upload'

// MEDIA_UPLOAD is only ever a beneficiary of other payIns. The fee itself lives
// in the BENEFACTOR's moneroUri (the benefactor reads it from uploadFees and
// folds it into its URI amount); this beneficiary carries piconeros 0n so the
// engine marks it PAID at creation and onPaid flips Upload.paid.

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

export async function onPaid (tx, payInId) {
  await tx.$executeRaw`
    UPDATE "Upload"
    SET "paid" = true
    FROM "UploadPayIn"
    WHERE "UploadPayIn"."payInId" = ${payInId}
      AND "Upload"."id" = "UploadPayIn"."uploadId"`
}
