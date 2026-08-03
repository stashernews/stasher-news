import { FREE_COMMENTS_PER_MONTH, USER_ID } from '@/lib/constants'
import { Prisma } from '@prisma/client'

// Get the first day of next month at midnight UTC
export function getNextMonthStart () {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0))
}

/**
 * Increment user's free comment counter after creating a freebie comment
 * @param {Object} tx - Prisma transaction
 * @param {Object} params - { item, userId }
 */
export async function incrementFreeCommentCount (tx, { item, userId }) {
  // Only increment for freebie comments (not bios), and not for anon
  if (!item.freebie || !item.parentId || userId === USER_ID.anon) return

  const user = await tx.user.findUnique({ where: { id: userId } })
  const now = new Date()
  const needsReset = user.freeCommentResetAt && now >= new Date(user.freeCommentResetAt)

  try {
    // these optimistic updates prevent races between the freebie check (outside of this tx)
    // if another concurrent freebie snuck in reaching/resetting the limit,
    // this prevents this freebie from being created
    if (needsReset || !user.freeCommentResetAt) {
      await tx.user.update({
        where: {
          id: userId,
          freeCommentResetAt: user.freeCommentResetAt
        },
        data: {
          freeCommentCount: 1,
          freeCommentResetAt: getNextMonthStart()
        }
      })
    } else {
      await tx.user.update({
        where: {
          id: userId,
          freeCommentCount: { lt: FREE_COMMENTS_PER_MONTH }
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
