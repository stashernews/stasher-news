import { makeIntegratedAddress } from './integratedAddress'
import { generateDownvotePaymentId } from './paymentId'
import { Prisma } from '@prisma/client'
import { META_SUB } from '@/lib/constants'

// Downvote address + payment_id reverse lookup (spec §3.3).
//
// When a user downvotes a post, they pay a fee-sized amount to the platform
// rewards wallet via an *integrated address* (primary rewards address + an
// 8-byte payment_id baked in). The payment_id deterministically encodes the
// (postId, nonce) pair; the rewardsWalletObserver later
// reverses it via reverseMapPaymentId to apply the downvote once the payment
// lands on-chain.

// makeDownvoteAddress(postId, nonce) -> { integratedAddress, paymentId }
//
// Pure: computes the downvote payment_id and folds it into the platform
// rewards primary address as a Monero integrated address. The DownvotePidMap
// row is recorded separately (Task 3's downZap getInitial) — this function
// performs no DB I/O. Throws if PLATFORM_REWARDS_ADDRESS is unset.
export function makeDownvoteAddress (postId, nonce) {
  const primary = process.env.PLATFORM_REWARDS_ADDRESS
  if (!primary) {
    throw new Error('PLATFORM_REWARDS_ADDRESS is not set')
  }
  const paymentId = generateDownvotePaymentId(postId, nonce)
  const { integratedAddress } = makeIntegratedAddress(primary, paymentId)
  return { integratedAddress, paymentId }
}

// reverseMapPaymentId(paymentId, models) -> Promise<row | null>
//
// Looks up the DownvotePidMap row for a detected payment_id. Returns the raw
// row (postId, nonce, userId, expiresAt, consumedAt) or null if no such
// payment_id was ever issued. Expiry/consumed filtering is the rewardsWalletObserver's
// concern, not ours.
export async function reverseMapPaymentId (paymentId, models) {
  return models.downvotePidMap.findUnique({ where: { paymentId } })
}

// Apply the LOG-scaled ranking penalty to the downvoted item and its ancestors.
// Mirrors the legacy downZap.js onPaid SQL, ported from millisats to piconeros:
// the ItemUserAgg.downvotePiconeros cumulative is cast ::BIGINT (not the legacy
// ::INTEGER) so piconeros-scale amounts never overflow INT4. The LOG ratio gives
// diminishing marginal weight: each additional piconero penalises less than the
// last (standard SN ranking curve). weightedDownVotes uses the downvoter's
// territory trust so a trusted curator's downvote counts more.
export async function applyDownvotePenalty (models, item, userId, piconeros) {
  const itemId = item.id
  const isComment = item.parentId != null
  const trustCol = isComment ? Prisma.sql`"zapCommentTrust"` : Prisma.sql`"zapPostTrust"`
  const subTrustCol = isComment ? Prisma.sql`"subZapCommentTrust"` : Prisma.sql`"subZapPostTrust"`

  await models.$executeRaw`
    WITH territory AS (
      SELECT COALESCE(r."subNames"[1], i."subNames"[1], ${META_SUB}::CITEXT) as "subName"
      FROM "Item" i
      LEFT JOIN "Item" r ON r.id = i."rootId"
      WHERE i.id = ${itemId}::INTEGER
    ), zapper AS (
      SELECT
        COALESCE(${trustCol}, 0) as "zapTrust",
        COALESCE(${subTrustCol}, 0) as "subZapTrust"
      FROM territory
      LEFT JOIN "UserSubTrust" ust ON ust."subName" = territory."subName"
        AND ust."userId" = ${userId}::INTEGER
    ), zap AS (
      INSERT INTO "ItemUserAgg" ("userId", "itemId", "downvotePiconeros")
      VALUES (${userId}::INTEGER, ${itemId}::INTEGER, ${piconeros}::BIGINT)
      ON CONFLICT ("itemId", "userId") DO UPDATE
      SET "downvotePiconeros" = "ItemUserAgg"."downvotePiconeros" + ${piconeros}::BIGINT, updated_at = now()
      RETURNING LOG("downvotePiconeros"::FLOAT / GREATEST("downvotePiconeros" - ${piconeros}, 1)::FLOAT) AS log_sats
    ), item_downzapped AS (
      UPDATE "Item"
      SET "weightedDownVotes" = "weightedDownVotes" + zapper."zapTrust" * zap.log_sats,
          "subWeightedDownVotes" = "subWeightedDownVotes" + zapper."subZapTrust" * zap.log_sats,
          "downPiconeros" = "downPiconeros" + ${piconeros}::BIGINT
      FROM zap, zapper
      WHERE "Item".id = ${itemId}::INTEGER
      RETURNING "Item".*
    )
    UPDATE "Item"
    SET "commentDownPiconeros" = "commentDownPiconeros" + ${piconeros}::BIGINT
    FROM (
      SELECT "Item".id FROM "Item", item_downzapped
      WHERE "Item".path @> item_downzapped.path AND "Item".id <> item_downzapped.id
      ORDER BY "Item".id
    ) AS ancestors
    WHERE "Item".id = ancestors.id`
}

// Inverse of applyDownvotePenalty for the reverseStaleDetections sweep (audit
// A-1). The forward applied zapTrust * LOG(after/before) where after = before +
// piconeros; after the give-back below the stored cumulative equals "before",
// so the RETURNING recomputes the SAME log factor and subtracts it exactly
// (exact under no interleaving; concurrent same-item downvotes interleave LOG
// accumulation in both directions — best-effort, same posture as tips).
export async function reverseDownvotePenalty (models, item, userId, piconeros) {
  const itemId = item.id
  const isComment = item.parentId != null
  const trustCol = isComment ? Prisma.sql`"zapCommentTrust"` : Prisma.sql`"zapPostTrust"`
  const subTrustCol = isComment ? Prisma.sql`"subZapCommentTrust"` : Prisma.sql`"subZapPostTrust"`

  await models.$executeRaw`
    WITH territory AS (
      SELECT COALESCE(r."subNames"[1], i."subNames"[1], ${META_SUB}::CITEXT) as "subName"
      FROM "Item" i
      LEFT JOIN "Item" r ON r.id = i."rootId"
      WHERE i.id = ${itemId}::INTEGER
    ), zapper AS (
      SELECT
        COALESCE(${trustCol}, 0) as "zapTrust",
        COALESCE(${subTrustCol}, 0) as "subZapTrust"
      FROM territory
      LEFT JOIN "UserSubTrust" ust ON ust."subName" = territory."subName"
        AND ust."userId" = ${userId}::INTEGER
    ), zap AS (
      UPDATE "ItemUserAgg"
      SET "downvotePiconeros" = GREATEST("ItemUserAgg"."downvotePiconeros" - ${piconeros}::BIGINT, 0), updated_at = now()
      WHERE "userId" = ${userId}::INTEGER AND "itemId" = ${itemId}::INTEGER
      RETURNING LOG(("downvotePiconeros" + ${piconeros}::BIGINT)::FLOAT / GREATEST("downvotePiconeros", 1)::FLOAT) AS log_sats
    ), item_undownzapped AS (
      UPDATE "Item"
      SET "weightedDownVotes" = "weightedDownVotes" - zapper."zapTrust" * zap.log_sats,
          "subWeightedDownVotes" = "subWeightedDownVotes" - zapper."subZapTrust" * zap.log_sats,
          "downPiconeros" = "downPiconeros" - ${piconeros}::BIGINT
      FROM zap, zapper
      WHERE "Item".id = ${itemId}::INTEGER
      RETURNING "Item".*
    )
    UPDATE "Item"
    SET "commentDownPiconeros" = "commentDownPiconeros" - ${piconeros}::BIGINT
    FROM (
      SELECT "Item".id FROM "Item", item_undownzapped
      WHERE "Item".path @> item_undownzapped.path AND "Item".id <> item_undownzapped.id
      ORDER BY "Item".id
    ) AS ancestors
    WHERE "Item".id = ancestors.id`
}
