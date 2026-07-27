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
// `MoneroAccount` is the registered wallet under monero-lws observation. Two
// of its fields are NOT columns on the Prisma model and are served by field
// resolvers in api/resolvers/monero.js (controller resolution #2):
//   - privacyMode           lives on the owner USER (User.privacyMode), not
//                            on MoneroAccount;
//   - subaddressPoolRemaining  is a computed count of AVAILABLE SubaddressIndex
//                            rows for the account.
//
// `PrivacyMode` mirrors the Prisma enum of the same name; `SubaddressInput`
// is the explicit-index pool shape consumed by register/addSubaddresses.

export default gql`
  extend type Query {
    myMoneroAccount: MoneroAccount
  }

  extend type Mutation {
    registerMoneroAccount(
      address: String!
      viewKey: String!
      privacyMode: PrivacyMode!
      subaddresses: [SubaddressInput!]
    ): MoneroAccount!
    addSubaddresses(
      accountId: ID!
      subaddresses: [SubaddressInput!]!
    ): MoneroAccount!
  }

  type MoneroAccount {
    id: ID!
    address: String!
    label: String!
    privacyMode: PrivacyMode!
    subaddressPoolRemaining: Int!
  }

  input SubaddressInput {
    majorIndex: Int!
    minorIndex: Int!
    address: String!
  }

  enum PrivacyMode {
    AUTO_INDEX
    MANUAL_PROOF
  }
`
