import { gql } from 'graphql-tag'

// Bounty funding typeDefs (A-13). Task 3 adds only the funding mutation +
// BountyFunding result type + the Item funding-status fields; the award /
// reclaim / rollover mutations and the BountyPayment payout type land in
// Task 4 (a duplicate `type BountyPayment` already exists in
// api/typeDefs/notifications.js as a Notification union member).
export default gql`
  extend type Mutation {
    fundBounty(postId: ID!): BountyFunding!
    payBounty(id: ID!, winnerCommentId: ID!): BountyPayment!
    reclaimBounty(id: ID!): BountyPayment!
    rolloverBounty(id: ID!): BountyPayment!
  }

  type BountyFunding {
    uri: String!
    integratedAddress: String!
    paymentId: String!
    feePiconeros: BigInt!
  }

  extend type Item {
    bountyStatus: BountyStatus!
    bountyPiconeros: BigInt!
  }

  extend type BountyPayment {
    itemId: Int
    winnerUserId: Int
    piconeros: BigInt
    kind: BountyPayoutKind
    state: BountyPayoutState
    txHash: String
    createdAt: Date
  }

  enum BountyPayoutKind {
    AWARD
    RECLAIM
    ROLLOVER
  }

  enum BountyPayoutState {
    QUEUED
    SENT
    CONFIRMED
    FAILED
  }

  enum BountyStatus {
    UNFUNDED
    PENDING_FUNDING
    DETECTED
    FUNDED
    EXPIRED
    AWARDED
    REFUNDED
    ROLLED_OVER
  }
`
