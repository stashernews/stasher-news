import { isP2POnly, isPayableWithCredits, isSystemOnly, isWithdrawal } from './is'
import { USER_ID } from '@/lib/constants'

export async function getPayInCustodialTokens (tx, mCustodialCost, payIn, { me }) {
  const payInCustodialTokens = []

  if (!me || me.id === USER_ID.anon || mCustodialCost <= 0n) {
    return payInCustodialTokens
  }

  if (mCustodialCost % 1000n !== 0n && !isWithdrawal(payIn) && !isSystemOnly(payIn)) {
    throw new Error('mCustodialCost must be a multiple of 1000 and is: ' + mCustodialCost)
  }

  const mCreditPayable = isPayableWithCredits(payIn) ? mCustodialCost : 0n

  // Calculate optimal spending to maximize custodial usage, preferring to spend credits,
  // while keeping any remainder as multiple of 1000 for invoice creation
  const [{ creditsSpent, creditsAfter, piconerosSpent, piconerosAfter }] = await tx.$queryRaw`
    WITH payer AS (
      SELECT
        id,
        "stackedPiconeros" AS piconeros,
        LEAST("stackedCredits", ${mCreditPayable}) as max_credits,
        (${mCustodialCost} - LEAST("stackedCredits", ${mCreditPayable})) % 1000 as max_credits_modulo_1000
      FROM users
      WHERE id = ${me.id}
      -- this only updates non-key balance columns, so FOR NO KEY UPDATE is the
      -- appropriate lock — and it matches the lock obtainRowLevelLocks already
      FOR NO KEY UPDATE
    ),
    user_spending AS (
      SELECT
        id,
        (CASE
          -- Strategy 1: Can we pay everything custodially?
          WHEN max_credits + piconeros >= ${mCustodialCost} THEN
            -- [min(the credits we have, the cost that can be paid with credits), what's left to pay with piconeros].sum() = mCustodialCost
            ARRAY[max_credits, ${mCustodialCost} - max_credits]
          -- Strategy 2: Can we spend all credits and maximize piconeros spending, but leaving a remainder of a multiple of 1000?
          WHEN piconeros >= max_credits_modulo_1000 THEN
            -- [min(the credits we have, the cost that can be paid with credits), the max piconeros we can spend that bring the remainder to a multiple of 1000].sum() < mCustodialCost
            ARRAY[max_credits,
                max_credits_modulo_1000 +
                  ((GREATEST(0, piconeros - max_credits_modulo_1000) / 1000) * 1000)]
          -- Strategy 3: Spend multiples of 1000 only for both credits and piconeros
          ELSE
            -- [credits floored to a multiple of 1000, piconeros floored to a multiple of 1000].sum() < mCustodialCost
            ARRAY[(max_credits / 1000) * 1000, (piconeros / 1000) * 1000]
        END)::BIGINT[] AS spending
      FROM payer
    )
    UPDATE users
    SET
      "stackedCredits" = "stackedCredits" - user_spending.spending[1],
      "stackedPiconeros" = "stackedPiconeros" - user_spending.spending[2]
    FROM user_spending
    WHERE users.id = user_spending.id
    RETURNING
      user_spending.spending[1] as "creditsSpent",
      users."stackedCredits" as "creditsAfter",
      user_spending.spending[2] as "piconerosSpent",
      users."stackedPiconeros" as "piconerosAfter"`

  if (creditsSpent > 0n) {
    payInCustodialTokens.push({
      custodialTokenType: 'CREDITS',
      mtokens: creditsSpent,
      mtokensAfter: creditsAfter
    })
  }

  if (piconerosSpent > 0n) {
    payInCustodialTokens.push({
      custodialTokenType: 'SATS',
      mtokens: piconerosSpent,
      mtokensAfter: piconerosAfter
    })
  }

  return payInCustodialTokens
}

function getP2PCost (payIn) {
  if (isP2POnly(payIn)) {
    return payIn.piconeros
  }
  // the Bolt11 invoice surface was removed: there is no bolt11 amount to round up, so P2P cost is 0
  return 0n
}

export function getCostBreakdown (payIn) {
  const mP2PCost = getP2PCost(payIn)
  const mCustodialCost = payIn.piconeros - mP2PCost

  return {
    mP2PCost,
    mCustodialCost
  }
}
