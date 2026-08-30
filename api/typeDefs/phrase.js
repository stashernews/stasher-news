import { gql } from 'graphql-tag'

export default gql`
  extend type Mutation {
    createAuth: AuthChallenge!
    linkPhrase(k1: String!, pubkey: String!, sig: String!): AuthMethods!
  }

  type AuthChallenge {
    id: ID!
    createdAt: Date!
    k1: String!
    pubkey: String
  }
`
