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
`
