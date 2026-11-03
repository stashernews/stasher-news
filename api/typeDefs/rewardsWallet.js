import { gql } from 'graphql-tag'

// StasherNews transparency surface: the public rewardsWalletInfo and
// rewardDistributions queries. No auth. Exposes the wallet address, its public
// view key (embedded in the address; cannot decode transaction amounts), the
// reconciliation status, the income mix as shares and the distribution log.
// The reserve, balance, all-time totals, rollovers and ops sweep amounts are
// deliberately absent: they are read by api/monero/rewardsWalletReport.js for
// operator surfaces only.
//
// Monetary fields are BigInt piconeros (1e-12 XMR).

export default gql`
  extend type Query {
    rewardsWalletInfo: RewardsWalletInfo!
    rewardDistributions(limit: Int): [RewardDistribution!]!
  }

  type RewardsWalletInfo {
    address: String!
    # The wallet's public view key (embedded in the address; cannot decode
    # transaction amounts). Never the private view key.
    viewKey: String!
    network: String!
    # True when the ledger-derived balance is negative, when accounting is
    # uncertain (unresolved journal attempts / contradictory facts), or when a
    # published audit reports a positive discrepancy.
    balanceNeedsReconciliation: Boolean!
    # Unresolved journal attempts, contradictory proven facts, or other
    # conditions where the ledger cannot be trusted to be complete. A missing
    # or stale audit is NOT uncertainty by itself.
    accountingUncertain: Boolean!
    # The latest scoped published CHECK/APPLY reconciliation audit, or null
    # before any check has been published.
    reconciliationCheckedAt: Date
    # True only when that latest audit's safe ledger fingerprint still matches
    # the current ledger. A stale check cannot clear a known discrepancy.
    reconciliationEvidenceCurrent: Boolean!
    # Hot-wallet network costs and sweeps exceed the ops earmark (unfunded ops debt).
    opsUnderfunded: Boolean!
    # NONE: no allocated reward is undelivered. COVERED / UNCOVERED: whether
    # the ledger balance covers the undelivered rewards.
    outstandingRewards: String!
    inflowMix: RewardsInflowMix!
  }

  # All-time CONFIRMED eligible inflow by source as basis points of the total,
  # plus the allocation % applied to each source. Shares only: all-time
  # amounts minus all-time payouts would rebuild the reserve.
  type RewardsInflowMix {
    downvoteBps: Int!
    postingFeeBps: Int!
    territoryFeeBps: Int!
    walletlessTipBps: Int!
    otherBps: Int!
    rewardsShareBps: Int!
    downvoteRewardsPct: Int!
    postingFeeRewardsPct: Int!
    territoryFeeRewardsPct: Int!
    walletlessTipRewardsPct: Int!
  }

  # A weekly rewards distribution run: the amount distributed to curators and
  # its individual RewardPayout rows with real on-chain tx hashes. The ops
  # sweep is swept to the ops wallet when the hot wallet has enough unlocked
  # change, otherwise it is deferred (SKIPPED_LOCKED) and rolls over.
  type RewardDistribution {
    id: Int!
    periodStart: Date!
    periodEnd: Date!
    distributedPiconeros: BigInt!
    payoutCount: Int!
    status: String!
    startedAt: Date
    completedAt: Date
    # The ops sweep's outcome and tx hashes; its amount is not published.
    opsSweepTxHash: String
    opsSweepState: String!
    # Dynamic curator budget record. Nullable because pre-feature
    # rows and backfilled history may not have these figures. Every tip stage
    # is a TOTAL; no tipper identity or config exclusion ID is exposed here.
    rawTipPiconeros: BigInt
    trustedTipPiconeros: BigInt
    tipperCount: Int
    breakerTripped: Boolean
    breakerRawTPiconeros: BigInt
    makeupPiconeros: BigInt
    tipT4Piconeros: BigInt
    multBps: Int
    dynamicBudgetPiconeros: BigInt
    dynamicBudgetMode: String
    curatorBudgetMode: String
    appliedCuratorBudgetPiconeros: BigInt
    eligibleTipStages: JSONObject
    payouts: [RewardPayout!]!
  }

  # A single curator payout within a distribution. curatorNym is the user's
  # display name (or null if anonymous); amountXmr is the piconeros rendered as
  # a decimal XMR string for direct display.
  #
  # NOTE: recipientAddress is deliberately NOT exposed here. The
  # rewardDistributions query is unauthenticated (transparency-by-design), and
  # exposing the payout address would link a curator's nym to their Monero
  # address — a linkage the Monero blockchain itself hides. The resolver may
  # still spread the column through; an undeclared field is invisible to
  # GraphQL clients.
  type RewardPayout {
    id: Int!
    curatorId: Int!
    curatorNym: String
    piconeros: BigInt!
    amountXmr: String!
    txHash: String
    state: String!
  }
`
