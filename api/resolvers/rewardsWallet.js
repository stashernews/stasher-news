import { decryptViewKey } from '../monero/viewkey'
import { piconerosToXmrDecimal } from '../monero/uri'
import { GqlInputError } from '@/lib/error'

// StasherNews public transparency query for the platform rewards wallet
// (spec §4.4, §6.4, §7.3). The rewards wallet is the ONLY custodial component:
// a single Monero hot wallet (MoneroAccount { label: 'platform_rewards' }) that
// receives all platform-bound revenue (downvotes, posting fees, territory fees).
//
// This resolver exposes — publicly, no auth — the wallet address, its PUBLIC
// view key (Monero view keys are audit-by-design), the live balance from lws,
// and the rewards/ops earmark split. The split is accounting-level: the wallet
// holds one consolidated balance, so inflow is partitioned by source × each
// source's allocation % (PlatformFeeConfig) and then scaled PROPORTIONALLY
// against the live balance. By construction the two earmarks sum to the balance
// exactly (opsEarmark is the floor remainder), so the transparency page never
// shows rounding drift.

// All FeeObservation feeTypes other than POSTING are territory fees (see the
// FeeType enum: TERRITORY_CREATE / TERRITORY_BILLING / TERRITORY_UNARCHIVE),
// and they all share the territoryFeeRewardsPct allocation.
function splitFeeGroups (groups) {
  let postingFeePiconeros = 0n
  let territoryFeePiconeros = 0n
  for (const g of groups ?? []) {
    const val = g?._sum?.piconeros ?? 0n
    if (g.feeType === 'POSTING') postingFeePiconeros += val
    else territoryFeePiconeros += val
  }
  return { postingFeePiconeros, territoryFeePiconeros }
}

// Proportional earmark against the LIVE consolidated balance. rewardsEarmark +
// opsEarmark === balance holds by construction (opsEarmark = balance -
// rewardsEarmark), independent of any floor in the inflow-side percentage split.
function computeEarmarks (balance, sources, config) {
  const { downvotePiconeros, postingFeePiconeros, territoryFeePiconeros } = sources
  const totalInflow = downvotePiconeros + postingFeePiconeros + territoryFeePiconeros

  const rewardsNumerator =
    downvotePiconeros * BigInt(config.downvoteRewardsPct) +
    postingFeePiconeros * BigInt(config.postingFeeRewardsPct) +
    territoryFeePiconeros * BigInt(config.territoryFeeRewardsPct)
  const rewardsInflow = rewardsNumerator / 100n
  const opsInflow = totalInflow - rewardsInflow

  const rewardsEarmark = totalInflow > 0n
    ? balance * rewardsInflow / totalInflow
    : 0n
  const opsEarmark = balance - rewardsEarmark

  return { rewardsEarmark, opsEarmark, totalInflow, rewardsInflow, opsInflow }
}

export default {
  Query: {
    async rewardsWalletInfo (parent, args, { models, monero }) {
      const network = (process.env.MONERO_NETWORK || 'stagenet').toUpperCase()
      const account = await models.moneroAccount.findFirst({
        where: { label: 'platform_rewards', network },
        include: { viewKey: true }
      })
      if (!account) throw new GqlInputError('rewards wallet not registered')

      const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
      if (!config) throw new GqlInputError('fee config not initialized')

      const info = await monero.getAddressInfo(account)
      const totalReceived = info.total_received ?? 0n
      const totalSent = info.total_sent ?? 0n
      const balance = totalReceived - totalSent

      const burns = await models.observedBurn.aggregate({
        _sum: { piconeros: true },
        where: { state: 'CONFIRMED' }
      })
      const downvotePiconeros = burns._sum?.piconeros ?? 0n

      const feeGroups = await models.feeObservation.groupBy({
        by: ['feeType'],
        _sum: { piconeros: true },
        where: { state: 'CONFIRMED' }
      })
      const { postingFeePiconeros, territoryFeePiconeros } = splitFeeGroups(feeGroups)

      const earmarks = computeEarmarks(
        balance,
        { downvotePiconeros, postingFeePiconeros, territoryFeePiconeros },
        config)

      return {
        address: account.address,
        viewKey: decryptViewKey(account.viewKey),
        network,
        totalReceivedPiconeros: totalReceived,
        totalSentPiconeros: totalSent,
        balancePiconeros: balance,
        balanceXmr: piconerosToXmrDecimal(balance),
        rewardsEarmarkPiconeros: earmarks.rewardsEarmark,
        opsEarmarkPiconeros: earmarks.opsEarmark,
        inflowBreakdown: {
          downvotePiconeros,
          postingFeePiconeros,
          territoryFeePiconeros,
          totalPiconeros: earmarks.totalInflow,
          rewardsPiconeros: earmarks.rewardsInflow,
          opsPiconeros: earmarks.opsInflow,
          downvoteRewardsPct: config.downvoteRewardsPct,
          postingFeeRewardsPct: config.postingFeeRewardsPct,
          territoryFeeRewardsPct: config.territoryFeeRewardsPct
        }
      }
    },

    // Public distribution log (spec §7.3). Returns recent RewardDistributions
    // with their RewardPayouts, curator nym resolved, and piconeros rendered as
    // XMR decimal for display. No auth — transparency-by-design.
    async rewardDistributions (parent, { limit = 10 }, { models }) {
      const distributions = await models.rewardDistribution.findMany({
        take: Math.min(limit || 10, 50),
        orderBy: { id: 'desc' },
        include: {
          payouts: {
            include: { curator: { select: { name: true } } },
            orderBy: { piconeros: 'desc' }
          }
        }
      })
      return distributions.map(d => ({
        ...d,
        payouts: d.payouts.map(p => ({
          ...p,
          curatorNym: p.curator?.name || null,
          amountXmr: piconerosToXmrDecimal(p.piconeros)
        }))
      }))
    }
  }
}
