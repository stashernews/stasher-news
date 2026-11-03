import { readRewardDistributions, readRewardsWalletInfo } from '@/api/monero/rewardsWalletReport'
import { jsonSafe } from './overview'

// The exact rewards-wallet ledger the public /transparency page no longer
// shows: balances, allocations, all-time inflow amounts, ops sweeps and the
// full distribution log. Private: served only by the guarded admin API.
export async function adminTreasury (models) {
  const [wallet, distributions] = await Promise.all([
    readRewardsWalletInfo(models),
    readRewardDistributions(models, { limit: 10 })
  ])
  return jsonSafe({
    wallet,
    distributions: distributions.map(({ payouts, ...row }) => ({
      ...row,
      payouts: payouts.map(({ id, curatorId, curatorNym, piconeros, txHash, state }) => ({ id, curatorId, curatorNym, piconeros, txHash, state }))
    }))
  })
}
