import { gql } from 'graphql-tag'

export default gql`
  type Draft {
    id: ID!
    type: String!
    title: String
    text: String
    url: String
    subName: String
    # JSON-encoded per-type extras: { bountyPiconeros } | { pollOptions, pollExpiresAt, randPollOptions }
    extra: String
    moneroWallPricePiconeros: BigInt
    moneroWallThresholdPiconeros: BigInt
    # total bytes of the uploads pinned by this draft (drives the menu's media meter; derived, not stored)
    pinnedMediaBytes: BigInt
    createdAt: Date!
    updatedAt: Date!
  }

  input DraftInput {
    id: ID
    type: String!
    title: String
    text: String
    url: String
    subName: String
    bountyPiconeros: String
    pollOptions: [String!]
    pollExpiresAt: Date
    randPollOptions: Boolean
    moneroWallPriceXmr: String
    moneroWallThresholdXmr: String
  }

  extend type Query {
    myDrafts: [Draft!]!
    # owner-scoped: resolves null for a missing or foreign draft
    draft(id: ID!): Draft
  }

  extend type Mutation {
    upsertDraft(input: DraftInput!): Draft!
    deleteDraft(id: ID!): Boolean!
  }
`
