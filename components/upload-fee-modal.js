import { useEffect, useState } from 'react'
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

// UploadFeeModal — the >10MB upload fee attached to an already-live record (a
// turf description edit, or a post/comment edit). Unlike the territory billing
// modal (Sub.billingStatus) and PostingFeeModal's create phase (Item.feeStatus),
// an edit has no record state that flips when THIS fee lands, so the modal polls
// the fee PayIn's feeCovered — the same cumulative gate that flips Upload.paid.
// The update itself is already live (fee payIns are born PAID, onBegin ran at
// creation and only the gated Upload.paid waits for the observation).
export default function UploadFeeModal ({ moneroUri, payInId, onClose }) {
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
        title='Payment detected — upload fee settled!'
        autoCloseMs={1500}
        onAutoClose={onClose}
      />
    )
  }

  return (
    <MoneroPaymentView
      moneroUri={moneroUri}
      amountPiconeros={feePiconeros}
      heading='Pay the upload fee'
      description={`Scan to send ${piconerosToMXmrDual(feePiconeros)} to the platform rewards wallet. Your update is already live — this settles the fee for your over-10MB upload.`}
    >
      <p className='text-muted text-center mt-3'>
        <small>
          Until it settles, your next save will charge this upload again.
        </small>
      </p>
    </MoneroPaymentView>
  )
}
