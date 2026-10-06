// Exact-credit authenticated atomic redemption of the flame boost credit
// (spec 2026-10-05-quest-rebalance-boost-credit, task 4). The purse is the
// StreakReward ledger: one available credit (unconsumed, unexpired) buys the
// rank-only promo weight of a paid boost on the author's own live post.
//
// This module must NOT import from api/resolvers/item.js (circular import
// protection): the item Mutation map supplies the META reader via the injected
// ctx.readItem callback.
import { GqlAuthenticationError, GqlInputError } from '@/lib/error'
import assertApiKeyNotPermitted from './apiKey'
import assertGofacYourself from './ofac'
import { lockRewardUser, rewardNow } from '@/api/quests/boost-credit'
import { canUseBoostCreditOnItem } from '@/lib/boost-credit'
import { BOOST_CREDIT_PICONEROS } from '@/lib/quests'

// PostgreSQL INTEGER upper bound — ids beyond it cannot exist.
const MAX_PG_INT = 2147483647

// Positional (validated) decimal integer strictly bounded at the DB's INTEGER
// range. Runs before any SQL is issued, so garbage can never reach a query.
function boundedId (value, name) {
  const text = typeof value === 'number' ? String(value) : value
  if (typeof text !== 'string' || !/^[0-9]+$/.test(text)) {
    throw new GqlInputError(`invalid ${name}`)
  }
  const id = Number(text)
  if (!Number.isSafeInteger(id) || id < 1 || id > MAX_PG_INT) {
    throw new GqlInputError(`invalid ${name}`)
  }
  return id
}

const UNAVAILABLE = 'boost credit unavailable'

/**
 * Redeem one exact boost credit (rewardId) on one exact item (itemId) owned by
 * the caller. One transaction, ordered per the spec:
 *
 *   1. auth → API-key guard → ID validation (before any SQL) → OFAC outside
 *   2. lock the user row (the universal reward-write lock), then the item row
 *   3. the item must be an eligible own live post BEFORE any receipt replay
 *   4. lock the exact owned BOOST reward row; a receipt consumed on THIS item
 *      is an idempotent success (return the item); any other state (consumed
 *      elsewhere, foreign, missing, wrong type) is rejected as unavailable
 *   5. wall time is read AFTER all locks (rewardNow) and the consume is a
 *      conditional UPDATE — consumedAt IS NULL AND expiresAt > now — so a
 *      credit that expired during a lock wait fails here, not at tx start
 *   6. require used.count === 1, then increment Item.promoBoostPiconeros by
 *      BOOST_CREDIT_PICONEROS; any failure rolls the whole transaction back
 *
 * Returns the item through ctx.readItem(null, { id }, { ...ctx, models: tx })
 * so the response keeps the path-aware META row and the normal GraphQL gates.
 * The caller never passes a user or an amount — the credit is worth exactly
 * BOOST_CREDIT_PICONEROS, to the caller's own account.
 */
export async function useBoostCredit (parent, { itemId, rewardId }, ctx) {
  const { me, models, headers, readItem } = ctx
  if (!me) throw new GqlAuthenticationError()
  assertApiKeyNotPermitted({ me })
  const targetId = boundedId(itemId, 'itemId')
  const creditId = boundedId(rewardId, 'rewardId')
  await assertGofacYourself({ models, headers })
  const userId = Number(me.id)

  return await models.$transaction(async tx => {
    // serialize every reward write for this user, then the item row: the same
    // lock order the grant path uses, so concurrent redemptions/grants cannot
    // interleave reads and writes
    if (!await lockRewardUser(tx, userId)) throw new GqlInputError(UNAVAILABLE)
    const [item] = await tx.$queryRaw`
      SELECT * FROM "Item" WHERE id = ${targetId}::INTEGER FOR UPDATE`
    if (!item) throw new GqlInputError(UNAVAILABLE)
    if (!canUseBoostCreditOnItem(item, userId)) throw new GqlInputError(UNAVAILABLE)

    // the exact owned BOOST row, locked: invalid shape is unavailable, but a
    // receipt already consumed on THIS item replays idempotently
    const [credit] = await tx.$queryRaw`
      SELECT id, "userId", "type", "consumedAt", "itemId", "expiresAt"
      FROM "StreakReward" WHERE id = ${creditId}::INTEGER FOR UPDATE`
    if (!credit || Number(credit.userId) !== userId || String(credit.type) !== 'BOOST') {
      throw new GqlInputError(UNAVAILABLE)
    }
    if (credit.consumedAt) {
      if (credit.itemId === targetId) {
        return await readItem(null, { id: targetId }, { ...ctx, models: tx })
      }
      throw new GqlInputError(UNAVAILABLE)
    }

    // wall clock read AFTER all locks: expiry is judged in the locked window
    const now = await rewardNow(tx)
    const used = await tx.streakReward.updateMany({
      where: { id: creditId, userId, type: 'BOOST', consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now, itemId: targetId }
    })
    if (used.count !== 1) throw new GqlInputError(UNAVAILABLE)
    await tx.item.update({
      where: { id: targetId },
      data: { promoBoostPiconeros: { increment: BOOST_CREDIT_PICONEROS } }
    })
    return await readItem(null, { id: targetId }, { ...ctx, models: tx })
  })
}
