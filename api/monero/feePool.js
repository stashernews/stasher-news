// Rewards-wallet fee subaddress pool (spec §5.6, §6.2).
//
// Posting and territory fees land on the single platform rewards wallet via
// DEDICATED subaddresses, pre-derived OFFLINE (scripts/derive-rewards-fee-subaddresses.js)
// and stored as SubaddressIndex rows. The running app never holds the rewards
// spend key; it only draws addresses from this pool and watches them via lws.
//
// Account-index convention on the rewards wallet:
//   major 1 = posting fees
//   major 2 = territory fees (create / billing / unarchive)
// (Major 0 is the wallet's primary address; Phase 4's downvotes use payment IDs,
//  not subaddresses, so they do not consume this pool.)

import prisma from '@/api/models'

export const REWARDS_POSTING_MAJOR = 1
export const REWARDS_TERRITORY_MAJOR = 2

const FEE_TYPE_TO_MAJOR = {
  POSTING: REWARDS_POSTING_MAJOR,
  TERRITORY_CREATE: REWARDS_TERRITORY_MAJOR,
  TERRITORY_BILLING: REWARDS_TERRITORY_MAJOR,
  TERRITORY_UNARCHIVE: REWARDS_TERRITORY_MAJOR
}

/** Resolve the platform_rewards wallet id for the active network. */
export async function getRewardsWalletId (models = prisma) {
  const network = (process.env.MONERO_NETWORK || 'stagenet').toUpperCase()
  const account = await models.moneroAccount.findFirst({
    where: { label: 'platform_rewards', network }
  })
  if (!account) throw new Error('getRewardsWalletId: platform_rewards wallet not registered')
  return account.id
}

/**
 * Atomically draw + reserve one AVAILABLE fee subaddress for a pending fee event.
 *
 * Uses FOR UPDATE SKIP LOCKED so concurrent draws never double-assign: if two
 * requests race for the last subaddress, one gets it and the other throws
 * "pool exhausted" (which the caller surfaces as "re-run derive-fee-pool").
 * Returns { id, major, minor, address }.
 */
export async function reserveFeeSubaddress (models, feeType) {
  const major = FEE_TYPE_TO_MAJOR[feeType]
  if (!major) throw new Error(`reserveFeeSubaddress: unknown feeType ${feeType}`)
  const walletId = await getRewardsWalletId(models)

  const rows = await models.$queryRaw`
    WITH next AS (
      SELECT id FROM "SubaddressIndex"
      WHERE "accountId" = ${walletId}::int
        AND "majorIndex" = ${major}::int
        AND state = 'AVAILABLE'
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE "SubaddressIndex" SET state = 'ASSIGNED'
    FROM next WHERE "SubaddressIndex".id = next.id
    RETURNING "SubaddressIndex".id, "SubaddressIndex"."majorIndex", "SubaddressIndex"."minorIndex", "SubaddressIndex".address`

  if (!rows || rows.length === 0) {
    throw new Error(`reserveFeeSubaddress: rewards-wallet fee pool exhausted for major=${major} (feeType=${feeType}); run sndev monero derive-fee-pool`)
  }
  const r = rows[0]
  return { id: r.id, major: r.majorIndex, minor: r.minorIndex, address: r.address }
}
