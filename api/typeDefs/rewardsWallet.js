import { gql } from 'graphql-tag'

// StealthNews transparency surface: the public rewardsWalletInfo query (spec
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
    periodInflow: RewardsPeriodInflow!
  }

  # All-time CONFIRMED inflow by source, plus the allocation % applied to each.
  type RewardsPeriodInflow {
    downvotePiconeros: BigInt!
    postingFeePiconeros: BigInt!
    territoryFeePiconeros: BigInt!
    totalPiconeros: BigInt!
    rewardsPiconeros: BigInt!
    opsPiconeros: BigInt!
    downvoteRewardsPct: Int!
    postingFeeRewardsPct: Int!
    territoryFeeRewardsPct: Int!
  }

  # A weekly rewards distribution run (spec §5, §6.2). Each distribution records
  # the pool total, the amount distributed to curators, the rollover, and its
  # individual RewardPayout rows with real on-chain tx hashes.
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
    payouts: [RewardPayout!]!
  }

  # A single curator payout within a distribution. curatorNym is the user's
  # display name (or null if anonymous); amountXmr is the piconeros rendered as
  # a decimal XMR string for direct display.
  type RewardPayout {
    id: Int!
    curatorId: Int!
    curatorNym: String
    recipientAddress: String!
    piconeros: BigInt!
    amountXmr: String!
    txHash: String
    state: String!
  }
`
