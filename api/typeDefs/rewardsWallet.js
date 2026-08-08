import { gql } from 'graphql-tag'

// StasherNews transparency surface: the public rewardsWalletInfo query (spec
// §4.4, §6.4, §7.3). Exposes the platform rewards wallet address, its PUBLIC
// view key (audit-by-design), the live balance, and the rewards/ops earmark
// split. No auth — this is a public-good transparency query.
//
// All monetary fields are BigInt piconeros (1e-12 XMR); balanceXmr is the same
// balance rendered as a decimal XMR string for direct display.

export default gql`
  extend type Query {
    rewardsWalletInfo: RewardsWalletInfo!
    rewardDistributions(limit: Int): [RewardDistribution!]!
  }

  type RewardsWalletInfo {
    address: String!
    viewKey: String!
    network: String!
    totalReceivedPiconeros: BigInt!
    totalSentPiconeros: BigInt!
    balancePiconeros: BigInt!
    balanceXmr: String!
    rewardsEarmarkPiconeros: BigInt!
    opsEarmarkPiconeros: BigInt!
    inflowBreakdown: RewardsInflowBreakdown!
  }

  # All-time CONFIRMED inflow by source, plus the allocation % applied to each.
  type RewardsInflowBreakdown {
    downvotePiconeros: BigInt!
    postingFeePiconeros: BigInt!
    territoryFeePiconeros: BigInt!
    walletlessTipPiconeros: BigInt!
    totalPiconeros: BigInt!
    rewardsPiconeros: BigInt!
    opsPiconeros: BigInt!
    downvoteRewardsPct: Int!
    postingFeeRewardsPct: Int!
    territoryFeeRewardsPct: Int!
    walletlessTipRewardsPct: Int!
  }

  # A weekly rewards distribution run (spec §5, §6.2). Each distribution records
  # the pool total, the amount distributed to curators, the rollover, and its
  # individual RewardPayout rows with real on-chain tx hashes. The ops-sweep
  # fields expose what happened to the ops earmark's share this period: it is
  # swept to the ops wallet when the hot wallet has enough unlocked change,
  # otherwise it is deferred (SKIPPED_LOCKED) and rolls into next period's
  # opsAvailable.
  type RewardDistribution {
    id: Int!
    periodStart: Date!
    periodEnd: Date!
    poolPiconeros: BigInt!
    distributedPiconeros: BigInt!
    rolledOverPiconeros: BigInt!
    payoutCount: Int!
    status: String!
    startedAt: Date
    completedAt: Date
    opsInflowPiconeros: BigInt!
    opsAvailablePiconeros: BigInt!
    opsSweptPiconeros: BigInt!
    opsSweepTxHash: String
    opsSweepState: String!
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
