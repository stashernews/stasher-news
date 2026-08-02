import { useQuery } from '@apollo/client/react'
import { useEffect, useRef } from 'react'
import { TIP_STATUS } from '@/fragments/monero'

// Polls tipStatus(paymentId) while a tip modal is open. Fires onDetected exactly
// once when the lws indexer first sees the payment (DETECTED), then stops. CONFIRMED
// is a silent background safety-net (confirmFinalizer) and intentionally triggers no
// UI here. Mirrors the poll-while-open contract of components/payIn/hooks/use-watch-pay-in.js
// but uses Apollo's idiomatic pollInterval (no wallet auto-pay controller needed).
const POLL_INTERVAL_MS = 3000

// Terminal states: stop polling once the tip reaches any of these. DETECTED is
// the success trigger (fires onDetected); CONFIRMED is the confirmFinalizer
// safety-net; EXPIRED/REORGED are failure terminals. PENDING/null keep polling.
const TERMINAL_STATES = new Set(['DETECTED', 'CONFIRMED', 'REORGED', 'EXPIRED'])

export default function useWatchTip ({ paymentId, onDetected }) {
  const { data, stopPolling } = useQuery(TIP_STATUS, {
    variables: { paymentId },
    pollInterval: POLL_INTERVAL_MS,
    fetchPolicy: 'network-only',
    skip: !paymentId
  })

  const state = data?.tipStatus?.state ?? null
  const firedRef = useRef(false)

  useEffect(() => {
    if (state === 'DETECTED' && !firedRef.current) {
      firedRef.current = true
      onDetected?.(data.tipStatus)
    }
    if (TERMINAL_STATES.has(state)) {
      stopPolling()
    }
  }, [state, data, onDetected, stopPolling])

  // stop polling on unmount (modal closed before detection)
  useEffect(() => () => stopPolling(), [stopPolling])

  return { state }
}
