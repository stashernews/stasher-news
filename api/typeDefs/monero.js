import { gql } from 'graphql-tag'

// StasherNews Monero wallet-setup GraphQL surface.
//
// Scope: ONLY the wallet-onboarding operations are defined here.
// The rest (setPrivacyMode, submitTipProof,
// observedTips, platformFeeConfig, rewardsWalletInfo, rewardDistributions,
// the ObservedTip / RewardsWalletInfo types, and the `moneroAddress` arg on
// upsertSub) is intentionally NOT defined here —
// YAGNI.
//
// `MoneroAccount` is the registered wallet under monero-lws observation. Its
// privacyMode field is NOT a column on the Prisma model and is served by a
// field resolver in api/resolvers/monero.js:
// privacyMode lives on the owner USER (User.privacyMode), not on
// MoneroAccount.
//
// `PrivacyMode` mirrors the Prisma enum of the same name and is retained as a
// forward-compat placeholder for Model B (manual-proof tipping).

export default gql`
  extend type Query {
    myMoneroAccount: MoneroAccount
    tipStatus(paymentId: String!): TipStatus
    downvoteStatus(paymentId: String!): DownvoteStatus
  }

  extend type Mutation {
    registerMoneroAccount(
      address: String!
      viewKey: String!
      privacyMode: PrivacyMode      # optional; defaults to AUTO_INDEX
    ): MoneroAccount!
    # Revoke wallet observation: flips the lws account to INACTIVE, wipes the
    # stored view key, and soft-deletes the local MoneroAccount (ownerUserId ->
    # null). The row is retained so past ObservedTip history stays intact (FK
    # RESTRICT) and so the same wallet can later be re-registered (upsert).
    unregisterMoneroAccount: Boolean!
    initiateTip(
      postId: ID!
      amount: String!
    ): TipInitiation!
  }

  type MoneroAccount {
    id: ID!
    address: String!
    label: String!
    # Nullable (M23): privacyMode lives on the owner User (User.privacyMode is
    # PrivacyMode? in the Prisma schema), and the resolver returns
    # parent.user?.privacyMode ?? null. A non-null contract here would break the
    # whole selection for any account whose owner has a null privacyMode
    # (GraphQL non-null violation), so the contract must match reality.
    # Retained as a forward-compat placeholder for future Model B.
    privacyMode: PrivacyMode
  }

  # Result of initiateTip: the integrated address + payment ID the tipper sends
  # to, plus a monero: URI for one-click wallet handoff.
  type TipInitiation {
    integratedAddress: String!
    paymentId: String!
    uri: String!
    # 'AUTHOR' = P2P to the post author's wallet; 'REWARDS' = the author has no
    # wallet, so the tip lands in the platform rewards pool instead.
    recipient: String!
  }

  enum PrivacyMode {
    AUTO_INDEX
    MANUAL_PROOF
  }

  # Polled by the tip modal while the user's wallet payment is pending.
  # Auth is capability-style: the paymentId (postId + nonce) is the unguessable token.
  type TipStatus {
    state: ObservedState!
    piconeros: BigInt!
    confirmations: Int!
  }

  # Polled by the downvote modal while the user's wallet payment is pending.
  # Auth is capability-style: the paymentId (postId + nonce) is the unguessable token.
  type DownvoteStatus {
    state: ObservedState!
    piconeros: BigInt!
    confirmations: Int!
  }

  enum ObservedState {
    PENDING
    DETECTED
    CONFIRMED
    REORGED
    EXPIRED
    EXCLUDED
  }
`
