import { gql } from 'graphql-tag'

export default gql`
  extend type Query {
    # The operator's site-wide announcement; NULL while the banner is off.
    announcement: String
    snl: Boolean! @deprecated(reason: "Use announcement; kept for clients loaded before the announcement banner.")
  }
`
