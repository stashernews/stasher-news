import { USER_ID } from '@/lib/constants'
import { freeCommentsQuota, freePostsQuota } from '@/api/monero/postingFee'
import { Prisma } from '@prisma/client'

// Get the first day of next month at midnight UTC
export function getNextMonthStart () {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0))
}

// Get the next 00:00 UTC midnight (start of tomorrow's daily window)
export function getNextDayStart () {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0))
}

/**
 * Increment user's free comment counter after creating a freebie comment.
 * The free-comment window is daily (resets 00:00 UTC).
 * Self-contained: fetches user + config inside the tx so the tier cap is
 * computed at increment time (a graduation between getInitial and onPaid is
 * handled correctly — the larger established quota is used).
 * @param {Object} tx - Prisma transaction
 * @param {Object} params - { item, userId }
 */
export async function incrementFreeCommentCount (tx, { item, userId }) {
  // Only increment for freebie comments (not bios, not posts), and not for anon
  if (!item.freebie || !item.parentId || userId === USER_ID.anon) return

  const user = await tx.user.findUnique({ where: { id: userId } })
  const config = await tx.platformFeeConfig.findUnique({ where: { id: 1 } })
  if (!config) return
  const quota = freeCommentsQuota(user, config)
  const now = new Date()
  const needsReset = user.freeCommentResetAt && now >= new Date(user.freeCommentResetAt)

  try {
    // Optimistic updates prevent races between the freebie check (outside this tx).
    // If another concurrent freebie snuck in reaching/resetting the limit, this
    // prevents this freebie from being created.
    if (needsReset || !user.freeCommentResetAt) {
      await tx.user.update({
        where: {
          id: userId,
          freeCommentResetAt: user.freeCommentResetAt
        },
        data: {
          freeCommentCount: 1,
          freeCommentResetAt: getNextDayStart()
        }
      })
    } else {
      await tx.user.update({
        where: {
          id: userId,
          freeCommentCount: { lt: quota }
        },
        data: {
          freeCommentCount: { increment: 1 }
        }
      })
    }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2025', 'P2034'].includes(error.code)) {
      throw new Error('no free comments left')
    }

    console.error('unexpected error', error)
    throw error
  }
}

/**
 * Increment user's free post counter after creating a free top-level post.
 * Self-guarding: no-op for comments, bios (freebie=true), paid posts
 * (feeStatus !== 'FEE_NOT_REQUIRED'), anon, or low-rep users (quota 0).
 * @param {Object} tx - Prisma transaction
 * @param {Object} params - { item, userId }
 */
export async function incrementFreePostCount (tx, { item, userId }) {
  // item.freebie is true for free comments/bios, false for (free or paid) posts.
  // A free post is a top-level, non-freebie item with no reserved fee subaddress.
  if (item.parentId || item.freebie || userId === USER_ID.anon) return
  if (item.feeStatus !== 'FEE_NOT_REQUIRED') return

  const user = await tx.user.findUnique({ where: { id: userId } })
  const config = await tx.platformFeeConfig.findUnique({ where: { id: 1 } })
  if (!config) return
  const quota = freePostsQuota(user, config)
  if (quota <= 0) return
  const now = new Date()
  const needsReset = user.freePostResetAt && now >= new Date(user.freePostResetAt)

  try {
    if (needsReset || !user.freePostResetAt) {
      await tx.user.update({
        where: {
          id: userId,
          freePostResetAt: user.freePostResetAt
        },
        data: {
          freePostCount: 1,
          freePostResetAt: getNextMonthStart()
        }
      })
    } else {
      await tx.user.update({
        where: {
          id: userId,
          freePostCount: { lt: quota }
        },
        data: {
          freePostCount: { increment: 1 }
        }
      })
    }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2025', 'P2034'].includes(error.code)) {
      throw new Error('no free posts left')
    }

    console.error('unexpected error', error)
    throw error
  }
}

// Bridge re-export: existing consumers (api/payIn/types/itemCreate.js,
// api/resolvers/user.js) still import commentsFreeLeft from '@/api/payIn/lib/freebie'.
// Tasks 3/4 switch them to import directly from '@/api/monero/postingFee'.
export { commentsFreeLeft } from '@/api/monero/postingFee'
