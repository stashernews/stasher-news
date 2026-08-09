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

// Bucket FeeObservation groupBy rows by source. TIP_UNWALLETED (wallet-less
// anonymous tips) and DONATE/BOOST have allocation pcts of their own — they
// must NOT be lumped in with territory fees.
function splitFeeGroups (groups) {
  let postingFeePiconeros = 0n
  let territoryFeePiconeros = 0n
  let walletlessTipPiconeros = 0n
  let donateBoostPiconeros = 0n
  const TERRITORY = new Set(['TERRITORY_CREATE', 'TERRITORY_BILLING', 'TERRITORY_UNARCHIVE', 'TERRITORY_UPDATE'])
  for (const g of groups ?? []) {
    const val = g?._sum?.piconeros ?? 0n
    if (g.feeType === 'POSTING') postingFeePiconeros += val
    else if (g.feeType === 'TIP_UNWALLETED') walletlessTipPiconeros += val
    else if (g.feeType === 'DONATE' || g.feeType === 'BOOST') donateBoostPiconeros += val
    else if (TERRITORY.has(g.feeType)) territoryFeePiconeros += val
  }
  return { postingFeePiconeros, territoryFeePiconeros, walletlessTipPiconeros, donateBoostPiconeros }
}

// Proportional earmark against the LIVE consolidated balance. rewardsEarmark +
// opsEarmark === balance holds by construction (opsEarmark = balance -
// rewardsEarmark), independent of any floor in the inflow-side percentage split.
function computeEarmarks (balance, sources, config) {
  const { downvotePiconeros, postingFeePiconeros, territoryFeePiconeros, walletlessTipPiconeros, donateBoostPiconeros } = sources
  const totalInflow = downvotePiconeros + postingFeePiconeros + territoryFeePiconeros + walletlessTipPiconeros + donateBoostPiconeros

  const rewardsNumerator =
    downvotePiconeros * BigInt(config.downvoteRewardsPct) +
    postingFeePiconeros * BigInt(config.postingFeeRewardsPct) +
    territoryFeePiconeros * BigInt(config.territoryFeeRewardsPct) +
    walletlessTipPiconeros * BigInt(config.walletlessTipRewardsPct) +
    donateBoostPiconeros * 100n
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
      const rawBalance = totalReceived - totalSent
      // lws reports lifetime received per-account but lifetime sent can include
      // spends of outputs on subaddresses whose receipts were never backfilled
      // into total_received (subaddresses registered after funds arrived). A
      // real wallet can never hold negative XMR, so clamp to 0 and flag the
      // accounting gap instead of surfacing a misleading negative balance.
      const balanceNeedsReconciliation = rawBalance < 0n
      const balance = balanceNeedsReconciliation ? 0n : rawBalance

      const downvotes = await models.observedDownvote.aggregate({
        _sum: { piconeros: true },
        where: { state: 'CONFIRMED' }
      })
      const downvotePiconeros = downvotes._sum?.piconeros ?? 0n

      const feeGroups = await models.feeObservation.groupBy({
        by: ['feeType'],
        _sum: { piconeros: true },
        where: { state: 'CONFIRMED' }
      })
      const { postingFeePiconeros, territoryFeePiconeros, walletlessTipPiconeros, donateBoostPiconeros } = splitFeeGroups(feeGroups)

      const earmarks = computeEarmarks(
        balance,
        { downvotePiconeros, postingFeePiconeros, territoryFeePiconeros, walletlessTipPiconeros, donateBoostPiconeros },
        config)

      return {
        address: account.address,
        viewKey: decryptViewKey(account.viewKey),
        network,
        totalReceivedPiconeros: totalReceived,
        totalSentPiconeros: totalSent,
        balancePiconeros: balance,
        balanceXmr: piconerosToXmrDecimal(balance),
        balanceNeedsReconciliation,
        rewardsEarmarkPiconeros: earmarks.rewardsEarmark,
        opsEarmarkPiconeros: earmarks.opsEarmark,
        inflowBreakdown: {
          downvotePiconeros,
          postingFeePiconeros,
          territoryFeePiconeros,
          walletlessTipPiconeros,
          totalPiconeros: earmarks.totalInflow,
          rewardsPiconeros: earmarks.rewardsInflow,
          opsPiconeros: earmarks.opsInflow,
          downvoteRewardsPct: config.downvoteRewardsPct,
          postingFeeRewardsPct: config.postingFeeRewardsPct,
          territoryFeeRewardsPct: config.territoryFeeRewardsPct,
          walletlessTipRewardsPct: config.walletlessTipRewardsPct
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
