import { canPostFree, getCachedPlatformFeeConfig } from '@/api/monero/postingFee'
import { notifyNewStreak } from '@/lib/webPush'
import { isVerifiedBadgeEnabled } from '@/lib/verified-badge-flag'

/**
 * Idempotently grant the verified badge graduation: insert the one-time VERIFIED
 * Streak row + send the notification, ONLY when the badge is enabled AND the
 * user has a registered wallet AND passes the age+reputation gate (canPostFree)
 * AND has no prior VERIFIED Streak. Safe to call from many trigger paths
 * (tip-confirm, wallet-register, item-create) — the WHERE NOT EXISTS guard
 * makes it fire exactly once.
 *
 * @param {Object} models - Prisma client (NOT a tx; this runs outside tipping txns)
 * @param {number} userId
 * @returns {Promise<boolean>} true if a new VERIFIED streak was inserted this call
 */
export async function maybeGrantVerifiedBadge (models, userId) {
  if (!isVerifiedBadgeEnabled()) return false
  if (!userId) return false
  const account = await models.moneroAccount.findFirst({ where: { ownerUserId: userId } })
  if (!account) return false

  const user = await models.user.findUnique({ where: { id: userId } })
  if (!user) return false
  const config = await getCachedPlatformFeeConfig(models)
  if (!config) return false
  if (!canPostFree(user, config)) return false

  const [verified] = await models.$queryRaw`
    INSERT INTO "Streak" ("userId", "startedAt", "type", created_at, updated_at)
    SELECT ${userId}::int, NOW(), 'VERIFIED'::"StreakType", now_utc(), now_utc()
    WHERE NOT EXISTS (
      SELECT 1 FROM "Streak" WHERE "userId" = ${userId}::int AND type = 'VERIFIED'
    )
    RETURNING "Streak".*`
  if (!verified) return false

  try {
    await notifyNewStreak(userId, verified)
  } catch (err) {
    // best-effort notification; the streak row is already inserted
    console.error('error sending verified badge notification:', err)
  }
  return true
}
