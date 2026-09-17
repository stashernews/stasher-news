import { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import { gql } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import { moneroUriAmountPiconeros, piconerosToMXmrDual } from '@/lib/format'
import MoneroPaymentView from './monero-payment-view'
import PaymentSuccessView from './payment-success-view'
import { useAnimation } from './animation'

const UPLOAD_FEE_POLL_MS = 10_000

const UPLOAD_FEE_STATUS = gql`
  query UploadFeeStatus($id: Int!) {
    payIn(id: $id) {
      id
      feeCovered
    }
  }
`

// UploadFeeModal — the >10MB upload fee attached to an item edit. A fee-bearing
// edit is deferred server-side (PendingItemUpdate): onBegin stores the edit and
// rewardsWalletObserver.flipPendingToLive applies it once the fee is observed.
// The modal polls PayIn.feeCovered — the same cumulative gate that flips
// Upload.paid and releases the deferred edit — and reports success only once
// the fee actually settles. Closing the QR without paying leaves the item
// unchanged (the pending edit is abandoned after FEE_ITEM_ABANDON_DAYS).
export default function UploadFeeModal ({ moneroUri, payInId, itemId, onClose }) {
  const router = useRouter()
  const animate = useAnimation()
  const [settled, setSettled] = useState(false)
  const feePiconeros = moneroUriAmountPiconeros(moneroUri) ?? 0n

  const { data } = useQuery(UPLOAD_FEE_STATUS, {
    variables: { id: Number(payInId) },
    skip: !payInId || settled,
    pollInterval: UPLOAD_FEE_POLL_MS
  })
  const covered = data?.payIn?.feeCovered === true

  useEffect(() => {
    if (!covered || settled) return
    setSettled(true)
    animate()
  }, [covered, settled, animate])

  if (settled) {
    return (
      <PaymentSuccessView
        title='Payment detected — your edit is going live!'
        autoCloseMs={1500}
        onAutoClose={() => {
          onClose()
          if (itemId) router.push(`/items/${itemId}`)
        }}
      />
    )
  }

  return (
    <MoneroPaymentView
      moneroUri={moneroUri}
      amountPiconeros={feePiconeros}
      heading='Pay the upload fee'
      description={`Scan to send ${piconerosToMXmrDual(feePiconeros)} to the platform rewards wallet. Your saved edit is applied as soon as this fee is detected — nothing has changed on the item yet.`}
    >
      <p className='text-muted text-center mt-3'>
        <small>
          Until it settles, your next save will charge this upload again. Closing this
          window leaves the item unchanged.
        </small>
      </p>
    </MoneroPaymentView>
  )
}
