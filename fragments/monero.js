import gql from 'graphql-tag'

// Starts a P2P tip. `amount` is a piconeros STRING (BigInt serialized as string).
// Returns the Cake-compatible monero: URI + the paymentId the modal polls.
export const INITIATE_TIP = gql`
  mutation initiateTip($postId: ID!, $amount: String!) {
    initiateTip(postId: $postId, amount: $amount) {
      uri
      paymentId
    }
  }
`

// Polled by the tip modal while the user's wallet payment is pending.
// Returns null until the ObservedTip row exists / is found.
export const TIP_STATUS = gql`
  query tipStatus($paymentId: String!) {
    tipStatus(paymentId: $paymentId) {
      state
      piconeros
      confirmations
    }
  }
`

// Polled by the downvote modal while the user's wallet payment is pending.
// Returns null until the ObservedBurn row exists / is found.
export const DOWNVOTE_STATUS = gql`
  query downvoteStatus($paymentId: String!) {
    downvoteStatus(paymentId: $paymentId) {
      state
      piconeros
      confirmations
    }
  }
`
