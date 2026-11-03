import { gql } from 'graphql-tag'

export default gql`
  extend type Query {
    rewards(when: [String!]): [Rewards!]
    meRewards(when: [String!]!): [MeRewards]
    curatorBudget: CuratorBudget!
    rewardsPoolHealth: RewardsPoolHealth!
  }

  # Public pool health. The reserve is never published (a large advertised
  # balance is a target); these are labels, shares, counts and a single payout
  # size that cannot be multiplied back into it.
  type RewardsPoolHealth {
    status: String                # GROWING | STABLE | DRAINING over the last 4 runs; NULL before 2 runs
    runway: String                # LT_1_MONTH | MONTHS_1_3 | MONTHS_3_6 | MONTHS_6_12 | YEAR_PLUS | NOT_DRAINING
    curatorShareBps: Int          # 4-run payouts / 4-run rewards income; NULL without income
    distributionCount: Int!
    payoutCount: Int!
    curatorCount: Int!
    deliveredPayoutBps: Int       # (SENT + CONFIRMED) / (SENT + CONFIRMED + FAILED); NULL before any payout
    medianPayoutPiconeros: BigInt # over the last 4 runs' paid payouts
  }

  # Live projection of this week's dynamic curator budget. It is
  # final at the Monday 00:00 UTC distribution. No tipper identities or config
  # exclusion IDs are exposed: every stage is a total. The reserve and the
  # spending limit derived from it are not exposed either.
  type CuratorBudget {
    mode: String!                 # LEGACY | SHADOW | ACTIVE (effective config)
    fallbackBudgetPiconeros: BigInt! # min(pool, 0.2 XMR cap); the cap is the upper bound while the pool is unavailable
    projectedPiconeros: BigInt    # dynamic projection; NULL when unavailable
    multBps: Int                  # EFFECTIVE multiple (budget x 10000 / T4); NULL when T4 = 0 or unavailable
    targetMultBps: Int!
    t4Piconeros: BigInt
    targetPiconeros: BigInt       # this week's target: k x T4 + approved make-up; NULL when unavailable
    drawdownWeeks: Int            # the W the copy must quote (ledger default 13, valid 4..104); NULL when unavailable
    dynamicBudgetMode: String     # FULL | DRAWDOWN | POOL_SHORT for the live projection; NULL when unavailable
    windingDown: Boolean!         # the last two recorded runs both ended in DRAWDOWN
    breakerTripped: Boolean!
  }

  extend type Mutation {
    donateToRewards(piconeros: BigInt!, rewardsPct: Int, sendProtocolId: Int): PayIn!
  }

  type DonateResult {
    piconeros: BigInt!
  }

  type Rewards {
    total: BigInt                 # distributed for a past week; NULL for the active cycle (the reserve is never published)
    time: Date!
    sources: [NameValue!]!        # that period's rewards income by source; never the rollover
    periodStart: Date
    periodEnd: Date
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
