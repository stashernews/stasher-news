// Narrow DB helpers for the flame boost credit and reward-write serialization
// (spec 2026-10-05-quest-rebalance-boost-credit, task 3).

/**
 * Take the row lock that serializes every reward write for one user (plan
 * review focus 3). The caller runs this inside the transaction that will do
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
 * The user's single available BOOST credit, if one is held (pure read, no
 * lock): unconsumed and not yet expired. Deterministic ordering — earliest
 * expiry first, then lowest id — so callers cannot race over "which" credit
 * is available. Rows already consumed or expired do not count, which is what
 * lets a fresh boost rung re-grant after the held one is spent or runs out.
 * Does not open a transaction implicitly.
 *
 * @param {Object} models - Prisma client or transaction client
 * @param {number} userId
 * @returns {Promise<{id: number, expiresAt: Date}|null>} available credit row, or null
 */
export async function availableBoostCredit (models, userId) {
  const rows = await models.$queryRaw`
    SELECT id, "expiresAt" FROM "StreakReward"
    WHERE "userId" = ${userId}::INTEGER AND type = 'BOOST'::"StreakRewardType"
      AND "consumedAt" IS NULL
      AND "expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')
    ORDER BY "expiresAt", id LIMIT 1`
  return rows[0] ?? null
}

/**
 * Per-request memoized availability read for the two UserPrivates fields
 * (spec §5.2: "Resolve both from the same available-credit reader"). The
 * GraphQL context object is built fresh per request by pages/api/graphql.js
 * (a plain object literal), so it is a safe cache key — unlike `models`,
 * which is a process-wide PrismaClient shared by every request. Memoizing
 * the PROMISE means both fields await one read, so a grant landing between
 * the two field resolutions can never surface an id from one row and an
 * expiry from another (or id without expiry). Callers must apply the
 * self-only identity guard BEFORE this helper runs, so at most one user id
 * per request can reach it.
 *
 * @param {Object} ctx - per-request GraphQL context ({ models, ... })
 * @param {number} userId
 * @returns {Promise<{id: number, expiresAt: Date}|null>} available credit row, or null
 */
export function resolveBoostCreditAvailability (ctx, userId) {
  ctx.boostCreditAvailability ??= availableBoostCredit(ctx.models, userId)
  return ctx.boostCreditAvailability
}
