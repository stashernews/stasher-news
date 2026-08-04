import { useQuery } from '@apollo/client/react'
import { useEffect, useRef } from 'react'
import { DOWNVOTE_STATUS } from '@/fragments/monero'

// Polls downvoteStatus(paymentId) while a downvote modal is open. Fires
// onDetected exactly once when the penaltyIndexer first observes the payment
// (DETECTED), then stops. CONFIRMED is a silent background safety-net
// (confirmFinalizer) and intentionally triggers no UI here. Mirrors the tip
// poll (components/tip/use-watch-tip.js).
const POLL_INTERVAL_MS = 3000

// Terminal states: stop polling once the downvote reaches any of these.
// DETECTED is the success trigger (fires onDetected); CONFIRMED is the
// confirmFinalizer safety-net; REORGED/EXPIRED are failure terminals.
// null/PENDING keep polling.
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
    if (state === 'DETECTED' && !firedRef.current) {
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
