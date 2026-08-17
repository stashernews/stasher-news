import { useRouter } from 'next/router'
import { useEffect } from 'react'
import { gql } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import { moneroUriAmountPiconeros, piconerosToXmr, underpayHint } from '@/lib/format'
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
  const feePiconeros = moneroUriAmountPiconeros(moneroUri) ?? 0n

  const { data } = useQuery(SUB_BILLING_STATUS, {
    variables: { name: String(subName) },
    pollInterval: SUB_BILLING_STATUS_POLL_MS
  })

  const billingStatus = data?.sub?.billingStatus

  const paid = billingStatus === 'PAID'

  // Short-pay hint: polled Sub fields are authoritative once they land; the paySub
  // response seeds the first render (the first poll is in flight). underpayHint
  // returns null when nothing received, fully covered, or inputs aren't BigInt.
  const polledReceived = data?.sub?.feeReceivedPiconeros
  const polledExpected = data?.sub?.billingFeePiconeros
  const received = polledReceived != null ? BigInt(polledReceived) : initialReceived != null ? BigInt(initialReceived) : 0n
  const expected = polledExpected != null ? BigInt(polledExpected) : initialExpected != null ? BigInt(initialExpected) : 0n
  const hint = !paid ? underpayHint(received, expected) : null

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

  return (
    <MoneroPaymentView
      moneroUri={moneroUri}
      amountPiconeros={feePiconeros}
      heading='Pay the turf fee'
      description={`Scan to send ${piconerosToXmr(feePiconeros)} to the platform rewards wallet. Your turf goes live once the fee is detected on-chain.`}
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
