import { USER_ID, IMAGE_PIXELS_MAX, UPLOAD_SIZE_MAX, UPLOAD_SIZE_MAX_AVATAR, UPLOAD_FREE_BYTES_MAX, UPLOAD_FEE_PICONEROS, UPLOAD_TYPES_ALLOW, AWS_S3_URL_REGEXP, AVATAR_TYPES_ALLOW, MEDIA_URL, DOMAIN_BETA_IDS } from '@/lib/constants'
import { createPresignedPost } from '@/api/s3'
import { GqlAuthenticationError, GqlAuthorizationError, GqlInputError } from '@/lib/error'
import { rateLimit } from '@/lib/rate-limit'
import { clientIp } from '@/lib/client-ip'
import { Prisma } from '@prisma/client'

export default {
  Query: {
    uploadFees: async (parent, { s3Keys }, { models, me }) => {
      const fees = await uploadFees(s3Keys, { models, me })
      // GraphQL doesn't support bigint
      return {
        totalFees: Number(fees.totalFees),
        totalFeesPiconeros: Number(fees.totalFeesPiconeros),
        uploadFees: Number(fees.uploadFees),
        uploadFeesPiconeros: Number(fees.uploadFeesPiconeros),
        nUnpaid: Number(fees.nUnpaid),
        bytesUnpaid: Number(fees.bytesUnpaid),
        bytes24h: Number(fees.bytes24h)
      }
    }
  },
  Mutation: {
    getSignedPOST: async (parent, { type, size, width, height, avatar, subName }, { models, me, headers }) => {
      if (!me) {
        const rl = rateLimit({ key: `upload:${clientIp(headers)}`, limit: 20, windowMs: 60 * 60_000 })
        if (!rl.allowed) throw new GqlInputError('upload rate limit exceeded, try again later')
      }

      if (UPLOAD_TYPES_ALLOW.indexOf(type) === -1) {
        throw new GqlInputError(`upload must be ${UPLOAD_TYPES_ALLOW.map(t => t.replace(/^(image|video)\//, '')).join(', ')}`)
      }

      if (size > UPLOAD_SIZE_MAX) {
        throw new GqlInputError(`upload must be less than ${UPLOAD_SIZE_MAX / (1024 ** 2)} megabytes`)
      }

      // free uploads: avatars are bound to the caller's photoId, sub assets to a sub they own.
      const isFreeAsset = avatar || subName
      if (isFreeAsset) {
        const assetType = subName ? 'territory asset' : 'avatar'
        if (AVATAR_TYPES_ALLOW.indexOf(type) === -1) {
          throw new GqlInputError(`${assetType} must be ${AVATAR_TYPES_ALLOW.map(t => t.replace('image/', '')).join(', ')}`)
        }

        if (size > UPLOAD_SIZE_MAX_AVATAR) {
          throw new GqlInputError(`${assetType} must be less than ${UPLOAD_SIZE_MAX_AVATAR / (1024 ** 2)} megabytes`)
        }
      }

      // width and height is 0 for videos
      if (width * height > IMAGE_PIXELS_MAX) {
        throw new GqlInputError(`image must be less than ${IMAGE_PIXELS_MAX} pixels`)
      }

      const fileParams = {
        type,
        size,
        width,
        height,
        userId: me?.id || USER_ID.anon,
        paid: false
      }

      if (isFreeAsset) {
        if (!me) throw new GqlAuthenticationError()
        if (subName) await assertCanUploadSubAsset({ me, subName, models })
        fileParams.paid = true
      }

      const upload = await models.upload.create({ data: { ...fileParams } })
      return createPresignedPost({ key: String(upload.id), type, size })
    }
  }
}

// mirrors the trust boundary enforced by `upsertSubBranding` so the free
// upload path can't be used outside of legitimate territory branding flows.
async function assertCanUploadSubAsset ({ me, subName, models }) {
  if (!DOMAIN_BETA_IDS.includes(Number(me.id))) {
    throw new GqlAuthorizationError('not allowed')
  }

  const sub = await models.sub.findUnique({
    where: { name: subName },
    select: { userId: true, domain: { select: { subName: true } } }
  })

  if (!sub) throw new GqlInputError('sub not found')
  if (Number(sub.userId) !== Number(me.id)) {
    throw new GqlAuthorizationError('you do not own this sub')
  }
  if (!sub.domain) throw new GqlInputError('requires a custom domain')
}

export function uploadIdsFromText (text) {
  if (!text) return []
  return [...new Set([...text.matchAll(AWS_S3_URL_REGEXP)].map(m => Number(m[1])))]
}

export async function uploadFees (s3Keys, { models, me }) {
  const userId = me?.id ?? USER_ID.anon

  if (!s3Keys || s3Keys.length === 0) {
    return {
      bytes24h: 0n,
      bytesUnpaid: 0n,
      nUnpaid: 0n,
      uploadFees: 0n,
      uploadFeesPiconeros: 0n,
      totalFees: 0n,
      totalFeesPiconeros: 0n
    }
  }

  const [{ bytesUnpaid, nUnpaid, totalFeesPiconeros }] = await models.$queryRaw`
    SELECT
      COALESCE(SUM(size) FILTER (WHERE paid = 'f' AND id IN (${Prisma.join(s3Keys)})), 0)::BIGINT AS "bytesUnpaid",
      COALESCE(COUNT(id) FILTER (WHERE paid = 'f' AND id IN (${Prisma.join(s3Keys)}) AND (size > ${UPLOAD_FREE_BYTES_MAX}::INTEGER OR ${userId} = ${USER_ID.anon})), 0)::BIGINT AS "nUnpaid",
      COALESCE(SUM(
        CASE
          WHEN size > ${UPLOAD_FREE_BYTES_MAX}::INTEGER
            THEN ${UPLOAD_FEE_PICONEROS} * (size / ${UPLOAD_FREE_BYTES_MAX}::INTEGER)::BIGINT
          WHEN ${userId} = ${USER_ID.anon} THEN ${UPLOAD_FEE_PICONEROS}
          ELSE 0::BIGINT
        END
      ) FILTER (WHERE paid = 'f' AND id IN (${Prisma.join(s3Keys)})), 0)::BIGINT AS "totalFeesPiconeros"
    FROM "Upload"
    WHERE "Upload"."userId" = ${userId}
      AND id IN (${Prisma.join(s3Keys)})`

  const uploadFeesPiconeros = totalFeesPiconeros
  const uploadFees = Number(totalFeesPiconeros)
  const totalFees = Number(totalFeesPiconeros)

  return {
    bytes24h: 0n,
    bytesUnpaid,
    nUnpaid,
    uploadFees,
    uploadFeesPiconeros,
    totalFees,
    totalFeesPiconeros
  }
}

export async function throwOnExpiredUploads (uploadIds, { tx }) {
  if (uploadIds.length === 0) return

  const existingUploads = await tx.upload.findMany({
    where: { id: { in: uploadIds } },
    select: { id: true }
  })

  const existingIds = new Set(existingUploads.map(upload => upload.id))
  const deletedIds = uploadIds.filter(id => !existingIds.has(id))

  if (deletedIds.length > 0) {
    throw new Error(`upload(s) ${deletedIds.map(id => `${MEDIA_URL}/${id}`).join(', ')} are expired, consider reuploading.`)
  }
}
