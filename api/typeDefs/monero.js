import { gql } from 'graphql-tag'

// StealthNews Monero wallet-setup GraphQL surface (spec §7.3).
//
// Scope (controller resolution #1): ONLY the wallet-onboarding operations from
// §7.3 land in Phase 2. The rest of §7.3 (setPrivacyMode, submitTipProof,
// observedTips, platformFeeConfig, rewardsWalletInfo, rewardDistributions,
// the ObservedTip / RewardsWalletInfo types, and the `moneroAddress` arg on
// upsertSub) belongs to Phase 3/4/5 and is intentionally NOT defined here —
// YAGNI.
//
// `MoneroAccount` is the registered wallet under monero-lws observation. Its
// privacyMode field is NOT a column on the Prisma model and is served by a
// field resolver in api/resolvers/monero.js (controller resolution #2):
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
  }
`
