import { useRouter } from 'next/router'
import { useEffect } from 'react'
import { gql } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import { moneroUriAmountPiconeros, piconerosToMXmrDual, underpayHint } from '@/lib/format'
import { postingFeeModalPhase } from '@/lib/pay-in'
import MoneroPaymentView from './monero-payment-view'
import PaymentSuccessView from './payment-success-view'
import { useAnimation } from './animation'

const SUB_BILLING_STATUS_POLL_MS = 10_000

const SUB_BILLING_STATUS = gql`
  query SubBillingStatus($name: String!) {
    sub(name: $name) {
      name
      billingStatus
      feeReceivedPiconeros
      billingFeePiconeros
    }
  }
`

export default function TerritoryPendingFeeModal ({ moneroUri, subName, onClose, receivedPiconeros: initialReceived, expectedPiconeros: initialExpected }) {
  const router = useRouter()
  const animate = useAnimation()
  const feePiconeros = moneroUriAmountPiconeros(moneroUri) ?? (initialExpected != null ? BigInt(initialExpected) : 0n)

  const { data } = useQuery(SUB_BILLING_STATUS, {
    variables: { name: String(subName) },
    pollInterval: SUB_BILLING_STATUS_POLL_MS
  })

  const billingStatus = data?.sub?.billingStatus

  // Short-pay hint: polled Sub fields are authoritative once they land; the paySub
  // response seeds the first render (the first poll is in flight). underpayHint
  // returns null when nothing received, fully covered, or inputs aren't BigInt.
  const polledReceived = data?.sub?.feeReceivedPiconeros
  const polledExpected = data?.sub?.billingFeePiconeros
  const received = polledReceived != null ? BigInt(polledReceived) : initialReceived != null ? BigInt(initialReceived) : 0n
  const expected = polledExpected != null ? BigInt(polledExpected) : initialExpected != null ? BigInt(initialExpected) : 0n
  const phase = postingFeeModalPhase(billingStatus === 'PAID' ? 'FEE_PAID' : billingStatus, received, expected)
  const paid = phase === 'paid'
  const hint = phase === 'waiting' ? underpayHint(received, expected) : null

  // navigate to the live territory once the fee is observed
  useEffect(() => {
    if (!paid) return
    animate()
    router.push(`/~${subName}`)
    const timer = setTimeout(() => onClose?.(), 1500)
    return () => clearTimeout(timer)
  }, [paid, subName, router, onClose, animate])

  if (paid) {
    return (
      <PaymentSuccessView
        title='Payment detected — your turf is live!'
        note='Redirecting…'
      />
    )
  }

  // Fully observed but not yet chain-verified enough to flip: show the waiting
  // state instead of a fresh QR (and never fall through to a fresh mint — the
  // resolver returns a null URI in this state; the 2026-09-19 re-quote bug).
  if (phase === 'detected') {
    return (
      <div className='d-flex flex-column align-items-center text-center'>
        <h6>Payment detected — waiting for confirmation</h6>
        <p className='text-muted mt-2'>
          <small>
            {piconerosToMXmrDual(expected)} received. Your turf goes live once the
            payment is confirmed on-chain.
          </small>
        </p>
      </div>
    )
  }

  // Defensive (review follow-up): a null URI must never reach the pay view —
  // the resolver only returns null for a fullyPaid response, so a null URI
  // with a non-detected phase means the polled state moved after that
  // response (e.g. a receipt was reversed). Never render a QR-less "scan to
  // send" view; ask for a re-open instead, which re-quotes the remainder.
  if (!moneroUri) {
    return (
      <div className='d-flex flex-column align-items-center text-center'>
        <h6>Payment status changed</h6>
        <p className='text-muted mt-2'>
          <small>
            A previously detected payment no longer counts toward this fee.
            Close and reopen this dialog for a fresh payment request.
          </small>
        </p>
      </div>
    )
  }

  return (
    <MoneroPaymentView
      moneroUri={moneroUri}
      amountPiconeros={feePiconeros}
      heading='Pay the turf fee'
      description={`Scan to send ${piconerosToMXmrDual(feePiconeros)} to the platform rewards wallet. Your turf goes live once the fee is detected on-chain.`}
    >
      {hint &&
        <p className='text-warning text-center mt-3'>
          <small>{hint}</small>
        </p>}
      <p className='text-muted text-center mt-3'>
        <small>
          Your turf stays hidden until the fee lands — detection takes about one block.
        </small>
      </p>
    </MoneroPaymentView>
  )
}
