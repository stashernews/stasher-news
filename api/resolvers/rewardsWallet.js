import { readRewardDistributions, readRewardsWalletInfo } from '../monero/rewardsWalletReport'

// StasherNews public transparency surface for the platform rewards wallet.
//
// Public, no auth: the wallet address, its PUBLIC view key, the reconciliation
// status, the all-time income mix as shares and the distribution log. The
// exact ledger (balance, received/sent, the reserve, rollovers, ops sweeps)
// is read by api/monero/rewardsWalletReport.js for operator surfaces only and
// is projected down here: advertising the balance makes the wallet a target,
// and the public view key cannot decode amounts on chain, so the API is the
// only place it could leak from. Every field below is whitelisted rather than
// spread, so a new report field is private until it is added on purpose.

const PUBLIC_DISTRIBUTION_FIELDS = [
  'id',
  'periodStart',
  'periodEnd',
  'distributedPiconeros',
  'payoutCount',
  'status',
  'startedAt',
  'completedAt',
  'opsSweepTxHash',
  'opsSweepState',
  'rawTipPiconeros',
  'trustedTipPiconeros',
  'tipperCount',
  'breakerTripped',
  'breakerRawTPiconeros',
  'makeupPiconeros',
  'tipT4Piconeros',
  'multBps',
  'dynamicBudgetPiconeros',
  'dynamicBudgetMode',
  'curatorBudgetMode',
  'appliedCuratorBudgetPiconeros',
  'eligibleTipStages',
  'payouts'
]

function shareBps (part, total) {
  return total > 0n ? Number(part * 10000n / total) : 0
}

// All-time income mix as basis points of total inflow; sources outside the
// four named ones (donations, bounty fees, boosts) fall into otherBps.
function inflowMix (breakdown) {
  const total = breakdown.totalPiconeros
  const downvoteBps = shareBps(breakdown.downvotePiconeros, total)
  const postingFeeBps = shareBps(breakdown.postingFeePiconeros, total)
  const territoryFeeBps = shareBps(breakdown.territoryFeePiconeros, total)
  const walletlessTipBps = shareBps(breakdown.walletlessTipPiconeros, total)
  return {
    downvoteBps,
    postingFeeBps,
    territoryFeeBps,
    walletlessTipBps,
    otherBps: total > 0n ? 10000 - downvoteBps - postingFeeBps - territoryFeeBps - walletlessTipBps : 0,
    rewardsShareBps: shareBps(breakdown.rewardsPiconeros, total),
    downvoteRewardsPct: breakdown.downvoteRewardsPct,
    postingFeeRewardsPct: breakdown.postingFeeRewardsPct,
    territoryFeeRewardsPct: breakdown.territoryFeeRewardsPct,
    walletlessTipRewardsPct: breakdown.walletlessTipRewardsPct
  }
}

export function publicWalletInfo (report) {
  const outstanding = report.outstandingRewardsPiconeros
  return {
    address: report.address,
    viewKey: report.viewKey,
    network: report.network,
    balanceNeedsReconciliation: report.balanceNeedsReconciliation,
    accountingUncertain: report.accountingUncertain,
    reconciliationCheckedAt: report.reconciliationCheckedAt,
    reconciliationEvidenceCurrent: report.reconciliationEvidenceCurrent,
    opsUnderfunded: report.opsDeficitPiconeros > 0n,
    outstandingRewards: outstanding <= 0n
      ? 'NONE'
      : report.balancePiconeros >= outstanding ? 'COVERED' : 'UNCOVERED',
    inflowMix: inflowMix(report.inflowBreakdown)
  }
}

// recipientAddress stays out: it would link a curator's nym to their address.
const PUBLIC_PAYOUT_FIELDS = ['id', 'curatorId', 'curatorNym', 'piconeros', 'amountXmr', 'txHash', 'state']

const pick = (row, keys) => Object.fromEntries(keys.map(key => [key, row[key]]))

export function publicDistribution (distribution) {
  return {
    ...pick(distribution, PUBLIC_DISTRIBUTION_FIELDS),
    payouts: distribution.payouts.map(payout => pick(payout, PUBLIC_PAYOUT_FIELDS))
  }
}

export default {
  Query: {
    async rewardsWalletInfo (parent, args, { models }) {
      return publicWalletInfo(await readRewardsWalletInfo(models))
    },

    async rewardDistributions (parent, { limit = 10 }, { models }) {
      const distributions = await readRewardDistributions(models, { limit })
      return distributions.map(publicDistribution)
    }
  }
}
