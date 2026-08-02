import { useQuery } from '@apollo/client/react'
import { useEffect, useRef } from 'react'
import { TIP_STATUS } from '@/fragments/monero'

// Polls tipStatus(paymentId) while a tip modal is open. Fires onDetected exactly
// once when the lws indexer first sees the payment (DETECTED), then stops. CONFIRMED
// is a silent background safety-net (confirmFinalizer) and intentionally triggers no
// UI here. Mirrors the poll-while-open contract of components/payIn/hooks/use-watch-pay-in.js
// but uses Apollo's idiomatic pollInterval (no wallet auto-pay controller needed).
const POLL_INTERVAL_MS = 3000

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
      stopPolling()
    }
  }, [state, data, onDetected, stopPolling])

  // stop polling on unmount (modal closed before detection)
  useEffect(() => () => stopPolling(), [stopPolling])

  return { state }
}
