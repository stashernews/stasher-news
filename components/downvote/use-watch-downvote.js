import { useQuery } from '@apollo/client/react'
import { useEffect, useRef } from 'react'
import { DOWNVOTE_STATUS } from '@/fragments/monero'
import { shouldTriggerPaymentSuccess } from '@/lib/pay-in'

// Polls downvoteStatus(paymentId) while a downvote modal is open. Fires
// onDetected exactly once when the penaltyIndexer first observes the payment
// (DETECTED) OR when the downvote is already CONFIRMED, then stops. CONFIRMED,
// normally reached via confirmFinalizer, must ALSO trigger success — a downvote
// already confirmed by the time the modal first polls would otherwise be a silent
// stop-polling terminal leaving the modal stuck with no success message and no
// close. REORGED/EXPIRED are failure terminals. Mirrors the tip poll
// (components/tip/use-watch-tip.js).
const POLL_INTERVAL_MS = 3000

// Terminal states: stop polling once the downvote reaches any of these.
// DETECTED/CONFIRMED are success triggers (fire onDetected); REORGED/EXPIRED are
// failure terminals. null/PENDING keep polling.
const TERMINAL_STATES = new Set(['DETECTED', 'CONFIRMED', 'REORGED', 'EXPIRED'])

export default function useWatchDownvote ({ paymentId, onDetected }) {
  const { data, stopPolling } = useQuery(DOWNVOTE_STATUS, {
    variables: { paymentId },
    pollInterval: POLL_INTERVAL_MS,
    fetchPolicy: 'network-only',
    skip: !paymentId
  })

  const state = data?.downvoteStatus?.state ?? null
  const firedRef = useRef(false)

  useEffect(() => {
    if (shouldTriggerPaymentSuccess(state) && !firedRef.current) {
      firedRef.current = true
      onDetected?.()
    }
    if (TERMINAL_STATES.has(state)) {
      stopPolling()
    }
  }, [state, onDetected, stopPolling])

  // stop polling on unmount (modal closed before detection)
  useEffect(() => () => stopPolling(), [stopPolling])

  return { state }
}
