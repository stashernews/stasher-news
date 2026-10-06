import { USER_ID } from '@/lib/constants'
import { freeCommentsQuota, freePostsQuota } from '@/api/monero/postingFee'
import { lockRewardUser } from '@/api/quests/boost-credit'
import { Prisma } from '@prisma/client'

// Get the first day of next month at midnight UTC
export function getNextMonthStart () {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0))
}

// Get the start of the next weekly free-reply window: the coming Monday
// 00:00 UTC, the same reset moment as the weekly rewards distribution cron
// (`0 0 * * 1`). Monday itself advances a full week — the window that opened
// at 00:00 today is the current one, so its reset is the following Monday.
export function getNextWeekStart () {
  const now = new Date()
  const daysAhead = ((8 - now.getUTCDay()) % 7) || 7
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysAhead, 0, 0, 0, 0))
}

/**
 * Spend one unit of the free-comment quota for a user, base-first: a live
 * weekly window increments the base counter; once the base is exhausted a
 * banked REPLY credit is consumed (soonest-expiring first). Throws
 * 'no free comments left' when neither is available.
 *
 * The CALLER must already serialize on the user row (payIn's begin holds the
 * payer lock via obtainRowLevelLocks; the flip bookkeeping calls
 * consumeQuotaForFlippedItem, which takes it explicitly): the decision reads
 * user state, so without that lock two concurrent creations can both observe
 * the last banked credit — the creation-time prospect (getInitial) runs
 * BEFORE payIn's payer lock. The optimistic where-guards below are kept as
 * belt and braces, mirroring the pre-existing base-increment guard.
 *
 * @param {Object} tx - Prisma transaction
 * @param {Object} params - { user, userId, itemId, config }
 */
async function spendCommentQuota (tx, { user, userId, itemId, config = null }) {
  const quota = freeCommentsQuota(user, config)
  const now = new Date()
  const needsReset = user.freeCommentResetAt && now >= new Date(user.freeCommentResetAt)

  if (needsReset || !user.freeCommentResetAt) {
    await tx.user.update({
      where: {
        id: userId,
        freeCommentResetAt: user.freeCommentResetAt
      },
      data: {
        freeCommentCount: 1,
        freeCommentResetAt: getNextWeekStart()
      }
    })
  } else if ((user.freeCommentCount || 0) >= quota) {
    // Base exhausted: consume one banked REPLY credit (soonest-expiring
    // first). No credit means the caller should not have granted a freebie
    // (a stale prospect whose credit a concurrent request spent, or a credit
    // that expired in flight): fail closed so the caller rolls the unpaid
    // free creation back instead of committing it for free.
    const consumed = await consumeStreakReward(tx, userId, 'REPLY', itemId ?? null)
    if (!consumed) throw new Error('no free comments left')
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
}

/**
 * Increment user's free comment counter after creating a freebie comment.
 * The free-comment window is weekly (resets Mondays 00:00 UTC, alongside the
 * weekly rewards distribution) with the flat one-tier quota (rev 3: quest
 * rewards bank REPLY credits instead of extending the increment guard).
 * Base-first: once the weekly base is exhausted, a banked REPLY credit is
 * consumed instead (soonest-expiring first), and exhaustion fails CLOSED
 * ('no free comments left') so begin() rolls the unpaid creation back.
 * Self-contained: fetches user + config inside the tx.
 * @param {Object} tx - Prisma transaction
 * @param {Object} params - { item, userId }
 */
export async function incrementFreeCommentCount (tx, { item, userId }) {
  // Only increment for freebie comments (not bios, not posts), and not for anon
  if (!item.freebie || !item.parentId || userId === USER_ID.anon) return

  const user = await tx.user.findUnique({ where: { id: userId } })
  const config = await tx.platformFeeConfig.findUnique({ where: { id: 1 } })
  if (!config) return

  try {
    // Optimistic updates prevent races between the freebie check (outside this tx).
    // If another concurrent freebie snuck in reaching/resetting the limit, this
    // prevents this freebie from being created.
    await spendCommentQuota(tx, { user, userId, itemId: item.id ?? null, config })
  } catch (error) {
    if (error?.message === 'no free comments left') {
      // expected exhaustion — not an unexpected failure
      throw error
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2025', 'P2034'].includes(error.code)) {
      throw new Error('no free comments left')
    }

    console.error('unexpected error', error)
    throw error
  }
}

/**
 * Atomically consume the user's soonest-expiring unconsumed reward of a type.
 * Returns true when a reward was consumed, false when none is available.
 * FOR UPDATE SKIP LOCKED keeps two concurrent creations from taking the same
 * row: the loser sees no row and the caller surfaces 'no free posts left'.
 */
export async function consumeStreakReward (prisma, userId, type = 'POST', itemId = null) {
  const rows = await prisma.$queryRaw`
    UPDATE "StreakReward" SET "consumedAt" = now_utc(), "itemId" = ${itemId}
    WHERE id = (
      SELECT id FROM "StreakReward"
      WHERE "userId" = ${userId} AND "type" = ${type}::"StreakRewardType"
        AND "consumedAt" IS NULL AND "expiresAt" > now_utc()
      ORDER BY "expiresAt" ASC, id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id`
  return rows.length > 0
}

/**
 * Increment user's free post counter after creating a free top-level post.
 * Self-guarding: no-op for comments, bios (freebie=true), paid posts
 * (feeStatus !== 'FEE_NOT_REQUIRED'), anon, or low-rep users (quota 0).
 * Base-first: once the monthly quota is exhausted, a banked flame post credit
 * is consumed instead (soonest-expiring first).
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
    // Base-first, then banked credits (soonest-expiring first).
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
    } else if ((user.freePostCount || 0) < quota) {
      await tx.user.update({
        where: {
          id: userId,
          freePostCount: { lt: quota }
        },
        data: {
          freePostCount: { increment: 1 }
        }
      })
    } else {
      const consumed = await consumeStreakReward(tx, userId, 'POST', item.id ?? null)
      if (!consumed) throw new Error('no free posts left')
    }
  } catch (error) {
    if (error?.message === 'no free posts left') {
      throw error
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2025', 'P2034'].includes(error.code)) {
      throw new Error('no free posts left')
    }

    console.error('unexpected error', error)
    throw error
  }
}

/**
 * Consume the free quota for a PENDING_FEE item at its fee flip
 * (worker/rewardsWalletObserver.js flipPendingToLive) — the R01 fix.
 *
 * The creation-time incrementFree* calls skip items that aren't freeborn
 * (freebie=false / feeStatus=PENDING_FEE), so an in-quota author whose only
 * on-chain cost was the upload fee never consumed quota. onBegin marks such
 * items feeQuotaEligible; this runs AFTER the flip commits, inside its OWN
 * best-effort transaction opened by flipPendingToLive, exactly once (only the
 * winning flip branch reaches it; re-polls match zero rows).
 *
 * The COMMENT branch is base-first and REPLY-credit-aware — the same spend as
 * the creation-time path: within the live weekly window the base counter is
 * incremented; once the base is exhausted a banked REPLY credit is consumed
 * (soonest-expiring first). It must be credit-aware because the creation gate
 * (commentQuotaFor) prices an upload-fee reply free off a banked credit;
 * force-incrementing an already-exhausted base counter would waive the reply
 * fee without ever spending the credit, repeatably. The POST branch is
 * unchanged base-first/POST-credit-aware.
 *
 * The user row lock is taken BEFORE any state is read: this transaction runs
 * outside the payIn that created the item, so without it the base-vs-credit
 * decision could read a stale pre-lock snapshot while a concurrent payIn or
 * quest-banking transaction is mid-flight. Lock order is user -> StreakReward
 * everywhere (payIn's obtainRowLevelLocks, banking's lockRewardUser, this),
 * so serializing here cannot deadlock.
 *
 * Failures — a missing/expired credit, or any DB error — SURFACE to the caller
 * by throwing: flipPendingToLive's guard logs + alerts with a per-payIn
 * dedupeKey. The item is already paid and stays live either way: the flip
 * committed in its own earlier transaction, so this bookkeeping can never roll
 * the publication back or wedge the observer cursor (R14). An over-quota count
 * is inert (free-left clamps at 0; the window reset re-baselines).
 *
 * @param {Object} tx - Prisma transaction opened by flipPendingToLive after the
 *   flip commits (best-effort; never the flip's tx)
 * @param {Object} params - { item, userId }
 */
export async function consumeQuotaForFlippedItem (tx, { item, userId }) {
  if (!item?.feeQuotaEligible || userId === USER_ID.anon) return

  // Serialize with every other writer of this user's quota/reward rows and
  // read the user only after the lock — no stale pre-lock snapshot.
  if (!await lockRewardUser(tx, userId)) return
  const user = await tx.user.findUnique({ where: { id: userId } })
  if (!user) return

  if (item.parentId) {
    await spendCommentQuota(tx, { user, userId, itemId: item.id ?? null })
    return
  }

  // POST branch semantics unchanged: base-first, then a banked POST credit,
  // and a missing credit is a no-op (never rejects the already-paid flip).
  const config = await tx.platformFeeConfig.findUnique({ where: { id: 1 } }).catch(() => null)
  const quota = config ? freePostsQuota(user, config) : 0
  const now = new Date()
  if (user.freePostResetAt && now < new Date(user.freePostResetAt)) {
    if ((user.freePostCount || 0) < quota) {
      await tx.user.update({ where: { id: userId }, data: { freePostCount: { increment: 1 } } })
    } else {
      await consumeStreakReward(tx, userId, 'POST', item.id ?? null)
    }
  } else {
    await tx.user.update({ where: { id: userId }, data: { freePostCount: 1, freePostResetAt: getNextMonthStart() } })
  }
}
