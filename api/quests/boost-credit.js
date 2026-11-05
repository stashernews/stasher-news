// Narrow DB helpers for the flame boost credit and reward-write serialization.

/**
 * Take the row lock that serializes every reward write for one user. The caller runs this inside the transaction that will do
 * the writes and acquires it BEFORE reading any user/streak state, so
 * concurrent sweeps, ladder advances, and redemption transactions can neither
 * double-grant a rung nor cross a banked cap: each writer re-reads committed
 * state under the lock. Resolves true when the user row exists (locked) and
 * false when it is gone — every caller must bail on false. Does not open a
 * transaction implicitly.
 *
 * @param {Object} tx - Prisma transaction client (or client) for the caller
 * @param {number} userId
 * @returns {Promise<boolean>} true iff user row read under lock
 */
export async function lockRewardUser (tx, userId) {
  const rows = await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::INTEGER FOR UPDATE`
  return rows.length === 1
}

/**
 * The database's wall clock, UTC, as a JS Date. Grant timestamps and expiries
 * come from here — never the application clock — so two processes cannot
 * disagree about when a credit was granted or when it expires. The caller's
 * transaction keeps this consistent-per-write. Does not open a transaction
 * implicitly.
 *
 * @param {Object} tx - Prisma transaction client (or client)
 * @returns {Promise<Date>} the read instant
 */
export async function rewardNow (tx) {
  const [row] = await tx.$queryRaw`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`
  return row.now
}

/**
 * The user's available BOOST credits (pure read, no lock): unconsumed and not
 * yet expired. Deterministic ordering — earliest expiry first, then lowest id —
 * so a partial spend always uses the credits closest to expiring. Rows already
 * consumed or expired do not count, which is what lets a boost rung re-grant
 * below the cap after a held credit is spent or runs out. Does not open a
 * transaction implicitly.
 *
 * @param {Object} models - Prisma client or transaction client
 * @param {number} userId
 * @returns {Promise<Array<{id: number, expiresAt: Date}>>} available credit rows
 */
export async function availableBoostCredits (models, userId) {
  return await models.$queryRaw`
    SELECT id, "expiresAt" FROM "StreakReward"
    WHERE "userId" = ${userId}::INTEGER AND type = 'BOOST'::"StreakRewardType"
      AND "consumedAt" IS NULL
      AND "expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')
    ORDER BY "expiresAt", id`
}
