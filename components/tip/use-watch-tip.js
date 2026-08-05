import { useQuery } from '@apollo/client/react'
import { useEffect, useRef } from 'react'
import { TIP_STATUS } from '@/fragments/monero'
import { shouldTriggerPaymentSuccess } from '@/lib/pay-in'

// Polls tipStatus(paymentId) while a tip modal is open. Fires onDetected exactly
// once when the lws indexer first sees the payment (DETECTED) OR when the tip is
// already CONFIRMED, then stops. CONFIRMED is normally reached via the
// confirmFinalizer safety-net; it must ALSO trigger success because a tip that is
// already confirmed by the time the modal first polls would otherwise be a silent
// stop-polling terminal — leaving the modal stuck with no success message and no
// close. REORGED/EXPIRED are failure terminals (no success). Mirrors the
// poll-while-open contract of components/payIn/hooks/use-watch-pay-in.js but uses
// Apollo's idiomatic pollInterval (no wallet auto-pay controller needed).
const POLL_INTERVAL_MS = 3000

// Stop polling once the tip reaches any of these. DETECTED/CONFIRMED are success
// triggers (fire onDetected); REORGED/EXPIRED are failure terminals.
// PENDING/null keep polling.
const TERMINAL_STATES = new Set(['DETECTED', 'CONFIRMED', 'REORGED', 'EXPIRED'])

export default function useWatchTip ({ paymentId, onDetected }) {
  const { data, stopPolling } = useQuery(TIP_STATUS, {
    variables: { paymentId },
    pollInterval: POLL_INTERVAL_MS,
    skip: !paymentId
  })

  const state = data?.tipStatus?.state ?? null
  const firedRef = useRef(false)

  useEffect(() => {
    if (shouldTriggerPaymentSuccess(state) && !firedRef.current) {
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
