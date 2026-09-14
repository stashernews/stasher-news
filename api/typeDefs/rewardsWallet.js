import { gql } from 'graphql-tag'

// StasherNews transparency surface: the public rewardsWalletInfo query (spec
// §4.4, §6.4, §7.3). Exposes the platform rewards wallet address, its public
// view key (embedded in the address; cannot decode transaction amounts), the
// live balance, and the LITERAL rewards/ops allocations (next distribution pool
// / pending ops sweep). No auth — this is a public-good transparency query.
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
    # The wallet's public view key (embedded in the address; cannot decode
    # transaction amounts). Never the private view key.
    viewKey: String!
    network: String!
    totalReceivedPiconeros: BigInt!
    totalSentPiconeros: BigInt!
    balancePiconeros: BigInt!
    balanceXmr: String!
    # True when the LEDGER-derived balance is negative (recorded sent > recorded
    # received — a real inconsistency, e.g. a payout recorded without matching
    # inflow). A real wallet can never hold negative XMR. The balance is NOT
    # clamped: a negative figure here is a genuine accounting bug to fix, not an
    # lws reporting artifact (lws's total_sent/spent_outputs misattribute other
    # wallets' spends to this account, so lws is never used for the balance).
    balanceNeedsReconciliation: Boolean!
    # Literal rewards allocation = the next distribution's pool: this cycle's
    # rewards-earmarked CONFIRMED inflow + the latest distribution's rollover.
    # Identical to the /rewards pool total (one shared computation,
    # getNextRewardsPool) — NOT a pro-rata slice of the balance.
    nextPoolPiconeros: BigInt!
    # Literal ops allocation = funds awaiting the ops sweep:
    # latest RewardDistribution.opsAvailablePiconeros - opsSweptPiconeros.
    # Matches the monero_ops_pending_piconeros metric; before the first
    # distribution it is this cycle's ops-earmarked inflow.
    pendingSweepPiconeros: BigInt!
    # Deprecated aliases of nextPoolPiconeros / pendingSweepPiconeros, kept so
    # existing clients' queries keep validating. The old pro-rata semantics
    # (tracking the all-time inflow mix rather than the actual allocation) were
    # misleading; these now return the literal values.
    rewardsEarmarkPiconeros: BigInt! @deprecated(reason: "Use nextPoolPiconeros — the value is now the literal allocation, not a pro-rata slice.")
    opsEarmarkPiconeros: BigInt! @deprecated(reason: "Use pendingSweepPiconeros — the value is now the literal allocation, not a pro-rata slice.")
    inflowBreakdown: RewardsInflowBreakdown!
  }

  # All-time CONFIRMED inflow by source, plus the allocation % applied to each.
  type RewardsInflowBreakdown {
    downvotePiconeros: BigInt!
    postingFeePiconeros: BigInt!
    territoryFeePiconeros: BigInt!
    walletlessTipPiconeros: BigInt!
    totalPiconeros: BigInt!
    rewardsPiconeros: BigInt!
    opsPiconeros: BigInt!
    downvoteRewardsPct: Int!
    postingFeeRewardsPct: Int!
    territoryFeeRewardsPct: Int!
    walletlessTipRewardsPct: Int!
  }

  # A weekly rewards distribution run (spec §5, §6.2). Each distribution records
  # the pool total, the amount distributed to curators, the rollover, and its
  # individual RewardPayout rows with real on-chain tx hashes. The ops-sweep
  # fields expose what happened to the ops earmark's share this period: it is
  # swept to the ops wallet when the hot wallet has enough unlocked change,
  # otherwise it is deferred (SKIPPED_LOCKED) and rolls into next period's
  # opsAvailable.
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
    opsInflowPiconeros: BigInt!
    opsAvailablePiconeros: BigInt!
    opsSweptPiconeros: BigInt!
    opsSweepTxHash: String
    opsSweepState: String!
    payouts: [RewardPayout!]!
  }

  # A single curator payout within a distribution. curatorNym is the user's
  # display name (or null if anonymous); amountXmr is the piconeros rendered as
  # a decimal XMR string for direct display.
  #
  # NOTE: recipientAddress is deliberately NOT exposed here. The
  # rewardDistributions query is unauthenticated (transparency-by-design), and
  # exposing the payout address would link a curator's nym to their Monero
  # address — a linkage the Monero blockchain itself hides. The resolver may
  # still spread the column through; an undeclared field is invisible to
  # GraphQL clients.
  type RewardPayout {
    id: Int!
    curatorId: Int!
    curatorNym: String
    piconeros: BigInt!
    amountXmr: String!
    txHash: String
    state: String!
  }
`
