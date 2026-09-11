import { publicViewKeyFromAddress } from '../monero/viewKeyCheck'
import { piconerosToXmrDecimal } from '../monero/uri'
import { GqlInputError } from '@/lib/error'

// StasherNews public transparency query for the platform rewards wallet
// (spec §4.4, §6.4, §7.3). The rewards wallet is the ONLY custodial component:
// a single Monero hot wallet (MoneroAccount { label: 'platform_rewards' }) that
// receives all platform-bound revenue (downvotes, posting fees, territory fees).
//
// This resolver exposes — publicly, no auth — the wallet address, its PUBLIC
// view key (address-embedded; derived from the address itself, never the
// stored/encrypted private key), the ledger-derived received/sent/balance,
// and the rewards/ops earmark split. The split is
// accounting-level: the wallet holds one consolidated balance, so inflow is
// partitioned by source × each source's allocation % (PlatformFeeConfig) and
// then scaled PROPORTIONALLY against the live balance. By construction the two
// earmarks sum to the balance exactly (opsEarmark is the floor remainder), so
// the transparency page never shows rounding drift.
//
// IMPORTANT: received/sent/balance come from the DATABASE LEDGER, NOT from
// lws's get_address_info. lws's total_sent/spent_outputs are unreliable for
// this account: lws attributes OTHER wallets' on-chain spends to it (observed:
// 33 foreign txs shown as 37e9 piconeros sent from a wallet whose full-key scan
// proves it never sent anything; lws's account-wide spent tracking includes
// fee-pool subaddress spends that were never backfilled into total_received).
// The ledger is the platform's own record: every piconero in is a CONFIRMED
// observation, every piconero out is a recorded payout or ops sweep.

// Bucket FeeObservation groupBy rows by source. TIP_UNWALLETED (wallet-less
// anonymous tips), DONATE, and BOOST have allocation pcts of their own — they
// must NOT be lumped in with territory fees. DONATE and BOOST are aggregated
// separately (A-14): DONATE goes the payer-chosen donationRewardsPct% to the
// pool (default 100) while BOOST goes boostRewardsPct% (default 30). The
// bounty sources (A-13) are bucketed separately too: BOUNTY_ROLLOVER goes 100%
// to the pool (the escrow's bounty portion physically arrives at this wallet)
// while BOUNTY_FEE counts to the ledger/ops side only (booked 100% ops at
// funding confirmation).
function splitFeeGroups (groups) {
  let postingFeePiconeros = 0n
  let territoryFeePiconeros = 0n
  let walletlessTipPiconeros = 0n
  let donatePiconeros = 0n
  let donateRewardsPiconeros = 0n
  let boostPiconeros = 0n
  let bountyRolloverPiconeros = 0n
  let bountyFeePiconeros = 0n
  const TERRITORY = new Set(['TERRITORY_CREATE', 'TERRITORY_BILLING', 'TERRITORY_UNARCHIVE', 'TERRITORY_UPDATE'])
  for (const g of groups ?? []) {
    const val = g?._sum?.piconeros ?? 0n
    if (g.feeType === 'POSTING') postingFeePiconeros += val
    else if (g.feeType === 'TIP_UNWALLETED') walletlessTipPiconeros += val
    else if (g.feeType === 'DONATE') {
      donatePiconeros += val
      donateRewardsPiconeros += val * BigInt(g.donationRewardsPct ?? 100) / 100n
    } else if (g.feeType === 'BOOST') boostPiconeros += val
    else if (g.feeType === 'BOUNTY_ROLLOVER') bountyRolloverPiconeros += val
    else if (g.feeType === 'BOUNTY_FEE') bountyFeePiconeros += val
    else if (TERRITORY.has(g.feeType)) territoryFeePiconeros += val
  }
  return { postingFeePiconeros, territoryFeePiconeros, walletlessTipPiconeros, donatePiconeros, donateRewardsPiconeros, boostPiconeros, bountyRolloverPiconeros, bountyFeePiconeros }
}

// Proportional earmark against the LIVE consolidated balance. rewardsEarmark +
// opsEarmark === balance holds by construction (opsEarmark = balance -
// rewardsEarmark), independent of any floor in the inflow-side percentage split.
function computeEarmarks (balance, sources, config) {
  const { downvotePiconeros, postingFeePiconeros, territoryFeePiconeros, walletlessTipPiconeros, donatePiconeros, donateRewardsPiconeros, boostPiconeros, bountyRolloverPiconeros, bountyFeePiconeros } = sources
  const totalInflow =
    downvotePiconeros + postingFeePiconeros + territoryFeePiconeros + walletlessTipPiconeros + donatePiconeros + boostPiconeros + bountyRolloverPiconeros + bountyFeePiconeros

  const rewardsNumerator =
    downvotePiconeros * BigInt(config.downvoteRewardsPct) +
    postingFeePiconeros * BigInt(config.postingFeeRewardsPct) +
    territoryFeePiconeros * BigInt(config.territoryFeeRewardsPct) +
    walletlessTipPiconeros * BigInt(config.walletlessTipRewardsPct) +
    donateRewardsPiconeros * 100n +
    boostPiconeros * BigInt(config.boostRewardsPct) +
    bountyRolloverPiconeros * 100n
  // BOUNTY_FEE has no numerator term: it physically arrived at this wallet but
  // was booked 100% ops at funding confirmation, so opsInflow absorbs it all.
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
    async rewardsWalletInfo (parent, args, { models }) {
      const network = (process.env.MONERO_NETWORK || 'stagenet').toUpperCase()
      const account = await models.moneroAccount.findFirst({
        where: { label: 'platform_rewards', network }
      })
      if (!account) throw new GqlInputError('rewards wallet not registered')

      const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
      if (!config) throw new GqlInputError('fee config not initialized')

      // --- Ledger-derived received: every CONFIRMED observation. ---
      // This matches lws's total_received when lws is accurate, but never
      // inherits lws's sent-side misattribution (see file header).
      const downvotes = await models.observedDownvote.aggregate({
        _sum: { piconeros: true },
        where: { state: 'CONFIRMED' }
      })
      const downvotePiconeros = downvotes._sum?.piconeros ?? 0n

      const feeGroups = await models.feeObservation.groupBy({
        by: ['feeType', 'donationRewardsPct'],
        _sum: { piconeros: true },
        where: { state: 'CONFIRMED' }
      })
      const { postingFeePiconeros, territoryFeePiconeros, walletlessTipPiconeros, donatePiconeros, donateRewardsPiconeros, boostPiconeros, bountyRolloverPiconeros, bountyFeePiconeros } = splitFeeGroups(feeGroups)
      const totalReceived =
        downvotePiconeros + postingFeePiconeros + territoryFeePiconeros + walletlessTipPiconeros + donatePiconeros + boostPiconeros + bountyRolloverPiconeros + bountyFeePiconeros

      // --- Ledger-derived sent: recorded payouts + ops sweeps. ---
      // The wallet's only outflows are curator payouts and ops sweeps, both
      // written to the DB before/after their on-chain tx. PENDING/FAILED
      // payouts and NOT_SWEEPED amounts never left the wallet.
      const [payoutAgg, sweepAgg] = await Promise.all([
        models.rewardPayout.aggregate({
          _sum: { piconeros: true },
          where: { state: { in: ['SENT', 'CONFIRMED'] } }
        }),
        models.rewardDistribution.aggregate({
          _sum: { opsSweptPiconeros: true }
        })
      ])
      const payoutPiconeros = payoutAgg._sum?.piconeros ?? 0n
      const opsSweptPiconeros = sweepAgg._sum?.opsSweptPiconeros ?? 0n
      const totalSent = payoutPiconeros + opsSweptPiconeros

      // The ledger is the platform's own record, so a negative balance is a
      // REAL inconsistency (sent more than received), not an lws artifact —
      // flag it, don't clamp.
      const balance = totalReceived - totalSent
      const balanceNeedsReconciliation = balance < 0n

      const earmarks = computeEarmarks(
        balance,
        { downvotePiconeros, postingFeePiconeros, territoryFeePiconeros, walletlessTipPiconeros, donatePiconeros, donateRewardsPiconeros, boostPiconeros, bountyRolloverPiconeros, bountyFeePiconeros },
        config)

      return {
        address: account.address,
        viewKey: publicViewKeyFromAddress(account.address),
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
