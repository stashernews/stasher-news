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
// close. REORGED/EXPIRED are failure terminals (no success).
//
// Polling is a plain setInterval + refetch: Apollo's own pollInterval cannot be
// relied on to survive React 19 StrictMode's double-mount (the remount reuses
// the cached ObservableQuery and never restarts the timer), while a fresh
// interval per mount always runs. The interval is torn down on unmount and on
// terminal states, so no timer outlives the modal.
const POLL_INTERVAL_MS = 3000

// Stop polling once the tip reaches any of these. DETECTED/CONFIRMED are success
// triggers (fire onDetected); REORGED/EXPIRED/EXCLUDED are failure terminals —
// EXCLUDED tips render the "not counted" copy (tip-modal tipStatusCopy) and
// must also tear down the interval, or the modal polls forever.
// PENDING/null keep polling.
export const TERMINAL_STATES = new Set(['DETECTED', 'CONFIRMED', 'REORGED', 'EXPIRED', 'EXCLUDED'])

export default function useWatchTip ({ paymentId, onDetected }) {
  const { data, refetch } = useQuery(TIP_STATUS, {
    variables: { paymentId },
    skip: !paymentId
  })

  const state = data?.tipStatus?.state ?? null
  const firedRef = useRef(false)

  useEffect(() => {
    if (TERMINAL_STATES.has(state)) return
    const timer = setInterval(() => {
      refetch().catch(() => {})
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [state, refetch])

  useEffect(() => {
    if (shouldTriggerPaymentSuccess(state) && !firedRef.current) {
      firedRef.current = true
      onDetected?.(data.tipStatus)
    }
  }, [state, data, onDetected])

  return { state }
}
