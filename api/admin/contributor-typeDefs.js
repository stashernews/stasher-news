import { gql } from 'graphql-tag'

export default gql`
  enum AdminContributorReason { PLAGIARISM AI_GENERATED RULES OTHER }
  type AdminContributorPost {
    id: Int!, title: String, authorId: Int!, authorName: String, deleted: Boolean!
    disqualifiedAt: String, disqualificationReason: AdminContributorReason
    note: String, notifyAt: String, version: String!
  }
  type AdminDisqualifiedContributorPost {
    id: Int!, title: String, authorId: Int!, authorName: String, deleted: Boolean!
    disqualifiedAt: String!, disqualificationReason: AdminContributorReason
    note: String, notifyAt: String
  }
  type AdminDisqualifiedContributorPage { total: Int!, rows: [AdminDisqualifiedContributorPost!]!, nextCursor: String }
  type AdminContributorRunSummary { id: Int!, periodEnd: String!, mode: String!, status: String!, hasSnapshot: Boolean! }
  type AdminContributorRunPage { rows: [AdminContributorRunSummary!]!, nextBeforeId: Int }
  type AdminContributorExclusion { reason: String!, count: Int! }
  type AdminContributorParameter { key: String!, value: String! }
  type AdminContributorFunding {
    curatorTarget: String, contributorTarget: String, room: String
    curatorBudget: String, contributorBudget: String, fitBps: String, scaled: Boolean
  }
  type AdminContributorAllocation { paid: String, rolledOver: String, winnerCap: String, combinedCap: String }
  type AdminContributorTrim { rule: String!, piconeros: String }
  type AdminContributorTipper { id: Int!, name: String }
  type AdminContributorScoredPost {
    itemId: Int!, authorId: Int!, title: String, authorName: String, available: Boolean!
    turf: String, rank: Int, qualifies: Boolean, tippers: Int, trustedTippers: Int
    base: Float, breadth: Float, commenters: Int, commentMultiplier: Float, score: Float
    trustedTipperAccounts: [AdminContributorTipper!]
    words: Int, lengthMultiplier: Float, weight: Float, rawShare: String, share: String
    trims: [AdminContributorTrim!]!
  }
  type AdminContributorSnapshot {
    id: Int!, periodEnd: String!, status: String!, mode: String!, configuredMode: String!
    available: Boolean!, warnings: [String!]!, errors: [String!]!
    windowStart: String, windowEnd: String, windowScored: Boolean, catchUpWeeks: Int
    candidates: Int, eligible: Int, qualifying: Int, nearMisses: Int, recordedRows: Int!
    exclusions: [AdminContributorExclusion!]!, parameters: [AdminContributorParameter!]!
    funding: AdminContributorFunding, allocation: AdminContributorAllocation
    appliedBudget: String, distributedAmount: String, posts: [AdminContributorScoredPost!]!
  }
  extend type Query {
    adminContributorPost(id: Int!): AdminContributorPost
    adminContributorRuns(beforeId: Int): AdminContributorRunPage!
    adminDisqualifiedContributorPosts(after: String): AdminDisqualifiedContributorPage!
    adminContributorSnapshot(id: Int!): AdminContributorSnapshot
  }
  extend type Mutation {
    adminSetContributorEligibility(id: Int!, expectedVersion: String!, disqualified: Boolean!,
      disqualificationReason: AdminContributorReason, note: String, notifyAuthor: Boolean! = false,
      reason: String!): AdminApplyResult!
  }
`
