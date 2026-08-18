import { gql } from '@apollo/client'
import { STREAK_FIELDS } from './streak-fields'

// Bounty-award wallet signal, kept OUT of the shared StreakFields (which must
// stay identical everywhere) and requested only on comment surfaces via this
// uniquely-named fragment — see fragments/streak-fields.js for why.
const COMMENT_WALLET_FIELDS = gql`
  fragment CommentWalletFields on User {
    optional {
      hasAttachedWallet
    }
  }
`

export const COMMENT_FIELDS = gql`
  ${STREAK_FIELDS}
  ${COMMENT_WALLET_FIELDS}
  fragment CommentFields on Item {
    id
    position
    parentId
    createdAt
    deletedAt
    text
    lexicalState
    html
    bountyAwardedAt
    user {
      id
      name
      meMute
      ...StreakFields
      ...CommentWalletFields
    }
    payIn {
      id
      payInState
      payInType
      moneroUri
      payInStateChangedAt
      payerPrivates {
        payInFailureReason
        retryCount
      }
    }
    piconeros
    credits
    meAnonPiconeros @client
    upvotes
    freedFreebie
    boost
    downPiconeros
    commentDownPiconeros
    mePiconeros
    meCredits
    meDontLikePiconeros
    meBookmark
    meSubscription
    freebie
    netInvestment
    path
    commentPiconeros
    commentCredits
    commentCost
    commentBoost
    mine
    otsHash
    ncomments
    nDirectComments
    live @client
    imgproxyUrls
    rel
    apiKey
    cost
    feeStatus
    feeReceivedPiconeros
  }
`

export const COMMENT_FIELDS_NO_CHILD_COMMENTS = gql`
  ${STREAK_FIELDS}
  ${COMMENT_WALLET_FIELDS}
  fragment CommentFieldsNoChildComments on Item {
    id
    position
    parentId
    createdAt
    deletedAt
    text
    lexicalState
    html
    user {
      id
      name
      meMute
      ...StreakFields
      ...CommentWalletFields
    }
    payIn {
      id
      payInState
      payInType
      moneroUri
      payInStateChangedAt
      payerPrivates {
        payInFailureReason
        retryCount
      }
    }
    piconeros
    credits
    meAnonPiconeros @client
    upvotes
    freedFreebie
    boost
    downPiconeros
    commentDownPiconeros
    mePiconeros
    meCredits
    meDontLikePiconeros
    meBookmark
    meSubscription
    freebie
    netInvestment
    path
    commentPiconeros
    commentCredits
    commentCost
    commentBoost
    mine
    otsHash
    live @client
    imgproxyUrls
    rel
    apiKey
    cost
    feeStatus
    feeReceivedPiconeros
  }
`

export const COMMENTS_ITEM_EXT_FIELDS = gql`
  ${STREAK_FIELDS}
  ${COMMENT_WALLET_FIELDS}
  fragment CommentItemExtFields on Item {
    text
    lexicalState
    html
    bountyAwardedAt
    root {
      id
      title
      bounty
      ncomments
      bountyPaidTo
      bountyStatus
      bountyPiconeros
      subNames
      subs {
        name
        userId
        meMuteSub
      }
      user {
        name
        id
        ...StreakFields
        ...CommentWalletFields
      }
    }
  }`

// we only get the first COMMENT_DEPTH_LIMIT comments
export const COMMENTS = gql`
  ${COMMENT_FIELDS}

  fragment CommentsRecursive on Item {
    ...CommentFields
    comments {
      comments {
        ...CommentFields
        comments {
          comments {
            ...CommentFields
            comments {
              comments {
                ...CommentFields
                comments {
                  comments {
                    ...CommentFields
                    comments {
                      comments {
                        ...CommentFields
                        comments {
                          comments {
                            ...CommentFields
                            comments {
                              comments {
                                ...CommentFields
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }`

export const HAS_COMMENTS = gql`
  fragment HasComments on Item {
    comments
  }
`

export const GET_NEW_COMMENTS = gql`
  ${COMMENT_FIELDS_NO_CHILD_COMMENTS}

  query GetNewComments($itemId: ID, $after: Date) {
    newComments(itemId: $itemId, after: $after) {
      comments {
        ...CommentFieldsNoChildComments
      }
    }
  }
`
