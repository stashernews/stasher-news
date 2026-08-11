import { useCallback, useEffect, useRef, useState } from 'react'
import { gql } from '@apollo/client'
import { useMutation, useQuery } from '@apollo/client/react'
import Button from 'react-bootstrap/Button'
import MoneroPaymentView from './monero-payment-view'
import PaymentSuccessView from './payment-success-view'
import { useRouter } from 'next/router'
import { piconerosToXmr } from '@/lib/format'
import { bountyFundingDescription } from '@/lib/bounty'
import { FUND_BOUNTY_MUTATION } from '@/fragments/payIn'

// Poll the item's bountyStatus while the funding view is open. Apollo's own
// pollInterval cannot be relied on to survive React 19 StrictMode's
// double-mount (the remount reuses the cached ObservableQuery and never
// restarts the timer), so this uses a plain setInterval + refetch, exactly like
// components/tip/use-watch-tip.js and use-watch-downvote.js.
const FUND_POLL_MS = 5000

const ITEM_BOUNTY_STATUS = gql`
  query ItemBountyStatus($id: ID!) {
    item(id: $id) {
      id
      bountyStatus
    }
  }`

// Post-create funding payment (A-13 Task 7 Step 2): calls fundBounty(postId)
// for the escrow integrated address + monero: URI, shows the payment view with
// the platform fee line, and polls bountyStatus until the funding confirms
// (FUNDED), then shows a success view and navigates to the post.
export default function BountyFundingView ({ postId, amountPiconeros, onClose }) {
  const router = useRouter()
  const [fund] = useMutation(FUND_BOUNTY_MUTATION)
  const [uri, setUri] = useState(null)
  const [feePiconeros, setFeePiconeros] = useState(null)
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [funded, setFunded] = useState(false)
  // StrictMode double-mount guard: fundBounty flips the item to
  // PENDING_FUNDING, so a second call would error even though the first
  // succeeded — mint the funding exactly once per view.
  const startedRef = useRef(false)
  const fundedRef = useRef(false)

  const run = useCallback(async () => {
    setError(null)
    setSubmitting(true)
    try {
      const res = await fund({ variables: { postId: String(postId) } })
      const funding = res?.data?.fundBounty
      if (!funding?.uri) {
        throw new Error('funding did not return a payment URI')
      }
      setUri(funding.uri)
      setFeePiconeros(funding.feePiconeros)
    } catch (error) {
      setError(error.message || 'failed to fund bounty')
    } finally {
      setSubmitting(false)
    }
  }, [fund, postId])

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    run()
  }, [run])

  const { data, refetch } = useQuery(ITEM_BOUNTY_STATUS, {
    variables: { id: String(postId) },
    skip: !uri || funded
  })
  const status = data?.item?.bountyStatus

  useEffect(() => {
    if (funded || status !== 'FUNDED') return
    if (fundedRef.current) return
    fundedRef.current = true
    setFunded(true)
  }, [status, funded])

  useEffect(() => {
    if (!uri || funded) return
    const timer = setInterval(() => {
      refetch().catch(() => {})
    }, FUND_POLL_MS)
    return () => clearInterval(timer)
  }, [uri, funded, refetch])

  if (funded) {
    return (
      <PaymentSuccessView
        title='Payment detected — your bounty is funded!'
        autoCloseMs={1500}
        onAutoClose={() => router.push(`/items/${postId}`)}
      />
    )
  }

  if (error) {
    return (
      <div className='d-flex flex-column align-items-center'>
        <h6>fund bounty</h6>
        <p className='text-muted text-center'>{error}</p>
        <div className='d-flex gap-2'>
          <Button variant='secondary' onClick={onClose}>cancel</Button>
          <Button variant='success' disabled={submitting} onClick={run}>retry</Button>
        </div>
      </div>
    )
  }

  if (!uri || !feePiconeros) {
    return (
      <div className='d-flex flex-column align-items-center'>
        <h6>fund bounty</h6>
        <p className='text-muted'>generating payment address…</p>
        <Button variant='secondary' onClick={onClose}>cancel</Button>
      </div>
    )
  }

  const amount = BigInt(amountPiconeros)

  return (
    <div className='p-3'>
      <MoneroPaymentView
        moneroUri={uri}
        amountPiconeros={amount}
        heading='Fund this bounty'
        description={bountyFundingDescription(amountPiconeros, feePiconeros)}
      >
        <p className='text-muted text-center mt-3'>
          <small>
            fee: {piconerosToXmr(BigInt(feePiconeros))} — the bounty pays out in full on award; the fee funds operations.
          </small>
        </p>
      </MoneroPaymentView>
      <p className='text-muted text-center mt-3'>
        <small>
          You can close this window and fund later from the post page — the bounty stays hidden until funded.
        </small>
      </p>
    </div>
  )
}
