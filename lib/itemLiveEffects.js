// Server-only item "went live" effects, shared between the payIn engine
// (immediately-live items: onPaid/onPaidSideEffects) and the fee observer
// (fee-gated items: worker/rewardsWalletObserver.js flipPendingToLive).
// Must NOT be merged into lib/item.js — that file is imported by client
// components and this one pulls in web-push.

import {
  notifyItemMention,
  notifyItemParents,
  notifyMention,
  notifyTerritorySubscribers,
  notifyThreadSubscribers,
  notifyUserSubscribers
} from '@/lib/webPush'
import { maybeGrantVerifiedBadge } from '@/api/verifiedBadge'

/**
 * Denormalize a comment's arrival into its ancestors (ncomments,
 * lastCommentAt, nDirectComments, commentCost) and insert the Reply rows used
 * by thread subscriptions/notifications. No-op for non-comments. Idempotency
 * is the caller's concern: run exactly once per comment (at onPaid for
 * immediately-live comments, at the fee flip for PENDING_FEE comments).
 * @param {Object} tx - Prisma transaction client
 * @param {Object} item - Item row carrying at least { id, parentId }
 */
export async function denormalizeComment (tx, item) {
  if (!item.parentId) return
  await tx.$executeRaw`
    WITH comment AS (
      SELECT "Item".*
      FROM "Item"
      JOIN users ON "Item"."userId" = users.id
      WHERE "Item".id = ${item.id}::INTEGER
    ), ancestors AS (
      SELECT "Item".*
      FROM "Item", comment
      WHERE "Item".path @> comment.path AND "Item".id <> comment.id
      ORDER BY "Item".id
    ), updated_ancestors AS (
      UPDATE "Item"
      SET ncomments = "Item".ncomments + 1,
        "lastCommentAt" = GREATEST("Item"."lastCommentAt", comment.created_at),
        "nDirectComments" = "Item"."nDirectComments" +
          CASE WHEN comment."parentId" = "Item".id THEN 1 ELSE 0 END,
        "commentCost" = "Item"."commentCost" + comment.cost
      FROM comment, ancestors
      WHERE "Item".id = ancestors.id
      RETURNING "Item".*
    )
    INSERT INTO "Reply" (created_at, updated_at, "ancestorId", "ancestorUserId", "itemId", "userId", level)
      SELECT comment.created_at, comment.updated_at, ancestors.id, ancestors."userId",
        comment.id, comment."userId", nlevel(comment.path) - nlevel(ancestors.path)
      FROM ancestors, comment`
}

/**
 * Fire every creation side effect for an item that just went live: the
 * verified-badge graduation check and all creation notifications. Never
 * throws for notification failures (fire-and-forget, matching the
 * onPaidSideEffects behavior this was extracted from).
 * @param {Object} models - Prisma client
 * @param {Object} item - Item row including mentions,
 *   itemReferrers: { include: { refereeItem } }, user
 */
export async function runItemLiveSideEffects (models, item) {
  // Verified-badge graduation check (age-crossing path): an active user posting
  // or commenting past day 7 may have crossed the gate since their last tip.
  try {
    await maybeGrantVerifiedBadge(models, item.userId)
  } catch (err) {
    console.error('verified badge check failed (itemCreate):', err)
  }

  if (item.parentId) {
    notifyItemParents({ item, models }).catch(console.error)
    notifyThreadSubscribers({ models, item }).catch(console.error)
  }
  for (const { userId } of item.mentions) {
    notifyMention({ models, item, userId }).catch(console.error)
  }
  for (const { refereeItem } of item.itemReferrers) {
    notifyItemMention({ models, referrerItem: item, refereeItem }).catch(console.error)
  }

  notifyUserSubscribers({ models, item }).catch(console.error)
  notifyTerritorySubscribers({ models, item }).catch(console.error)
}
