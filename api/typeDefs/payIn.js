import { gql } from 'graphql-tag'

export default gql`

extend type Query {
  payIn(id: Int!): PayIn
  statistics(cursor: String, walletId: ID): Statistics
  failedPayIns: [PayIn!]!
}

extend type Mutation {
  retryPayIn(payInId: Int!, sendProtocolId: Int): PayIn!
}

type Statistics {
  payIns: [PayIn!]!
  cursor: String
}

enum CustodialTokenType {
  CREDITS
  SATS
}

enum PayInType {
  BUY_CREDITS
  ITEM_CREATE
  ITEM_UPDATE
  TIP
  DOWNVOTE
  BOOST
  DONATE
  POLL_VOTE
  INVITE_GIFT
  TERRITORY_CREATE
  TERRITORY_UPDATE
  TERRITORY_BILLING
  TERRITORY_UNARCHIVE
  PROXY_PAYMENT
  REWARDS
  WITHDRAWAL
  AUTO_WITHDRAWAL
  MEDIA_UPLOAD
  BOUNTY_PAYMENT
  DEFUNCT_TERRITORY_DAILY_PAYOUT
}

enum PayInState {
  PENDING_PAYMENT
  DETECTED
  CONFIRMED
  FAILED
  PAID
}

enum PayInFailureReason {
  INVOICE_CREATION_FAILED
  INVOICE_WRAPPING_FAILED_HIGH_PREDICTED_FEE
  INVOICE_WRAPPING_FAILED_HIGH_PREDICTED_EXPIRY
  INVOICE_WRAPPING_FAILED_UNKNOWN
  INVOICE_FORWARDING_CLTV_DELTA_TOO_LOW
  INVOICE_FORWARDING_FAILED
  HELD_INVOICE_UNEXPECTED_ERROR
  HELD_INVOICE_SETTLED_TOO_SLOW
  WITHDRAWAL_FAILED
  USER_CANCELLED
  SYSTEM_CANCELLED
  INVOICE_EXPIRED
  EXECUTION_FAILED
  UNKNOWN_FAILURE
}

enum PayInWalletRole {
  SEND
  RECEIVE
}

type PayInWalletInfo {
  walletId: ID!
  walletName: String!
  protocolId: Int!
  protocolName: String!
  role: PayInWalletRole!
}

type PayInCustodialToken {
  id: Int!
  payInId: Int!
  mtokens: BigInt!
  mtokensAfter: BigInt
  custodialTokenType: CustodialTokenType!
}

type RefundCustodialToken {
  id: Int!
  payInId: Int!
  mtokens: BigInt!
  mtokensAfter: BigInt
  custodialTokenType: CustodialTokenType!
}

union PayInResult = Item | ItemAct | PollVote | Sub

type PayInPessimisticEnv {
  id: Int!
  payInId: Int!
  args: JSONObject
  error: String
  result: JSONObject
}

type PayIn {
  id: Int!
  createdAt: Date!
  updatedAt: Date!
  piconeros: BigInt!
  moneroUri: String
  isSend: Boolean
  payInType: PayInType!
  payInState: PayInState!
  payInStateChangedAt: Date!
  genesisId: Int
  successorId: Int
  payerPrivates: PayerPrivates
  payOutCustodialTokens: [PayOutCustodialToken!]
  item: Item
  walletInfo: PayInWalletInfo
}

type PayerPrivates {
  userId: Int!
  payInFailureReason: PayInFailureReason
  retryCount: Int
  payInCustodialTokens: [PayInCustodialToken!]
  refundCustodialTokens: [RefundCustodialToken!]
  result: PayInResult
  pessimisticEnv: PayInPessimisticEnv
  invite: Invite
  sub: Sub
}

enum PayOutType {
  TERRITORY_REVENUE
  REWARDS_POOL
  ROUTING_FEE
  ROUTING_FEE_REFUND
  PROXY_PAYMENT
  TIP
  BOUNTY_PAYMENT
  REWARD
  INVITE_GIFT
  WITHDRAWAL
  SYSTEM_REVENUE
  BUY_CREDITS
  INVOICE_OVERPAY_SPILLOVER
  DEFUNCT_REFERRAL_ACT
  DEFUNCT_DELAYED_TERRITORY_REVENUE
}

enum WithdrawlStatus {
  INSUFFICIENT_BALANCE
  INVALID_PAYMENT
  PATHFINDING_TIMEOUT
  ROUTE_NOT_FOUND
  CONFIRMED
  UNKNOWN_FAILURE
}

type PayOutCustodialToken {
  id: Int!
  payInId: Int!
  mtokens: BigInt!
  privates: PayOutCustodialTokenPrivates
  sometimesPrivates: PayOutCustodialTokenSometimesPrivates
  custodialTokenType: CustodialTokenType!
  payOutType: PayOutType!
  payIn: PayIn!
  sub: Sub
}

type PayOutCustodialTokenPrivates {
  mtokensAfter: BigInt
}

type PayOutCustodialTokenSometimesPrivates {
  user: User
  userId: Int
}
`
