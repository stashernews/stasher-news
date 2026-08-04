import { gql } from 'graphql-tag'

export default gql`
  extend type Query {
    rewards(when: [String!]): [Rewards!]
    meRewards(when: [String!]!): [MeRewards]
  }

  extend type Mutation {
    donateToRewards(piconeros: BigInt!, sendProtocolId: Int): PayIn!
  }

  type DonateResult {
    piconeros: BigInt!
  }

  type Rewards {
    total: BigInt!
    time: Date!
    sources: [NameValue!]!
  }

  type Reward {
    type: String
    rank: Int
    piconeros: BigInt!
    item: Item
  }

  type MeRewards {
    total: BigInt!
    rewards: [Reward!]
  }
`
