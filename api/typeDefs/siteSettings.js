import { gql } from 'graphql-tag'

export default gql`
  extend type Query { siteSettings: PublicSiteSettings! }
  type PublicSiteSettings {
    maxItemTurfs: Int!
    itemEditSeconds: Int!
    homepagePostsFilterPiconeros: BigInt!
    defaultPostsFilterPiconeros: BigInt!
    defaultCommentsFilterPiconeros: BigInt!
    anonPostFeeMultiplier: Int!
    anonCommentFeeMultiplier: Int!
    postingFeeFloorPiconeros: BigInt!
    commentFeePiconeros: BigInt!
    itemSpamIntervalMinutes: Int!
    spamEscalationNumerator: Int!
    spamEscalationDenominator: Int!
  }
`
