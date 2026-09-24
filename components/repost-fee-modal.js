import { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import { gql } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import { moneroUriAmountPiconeros, piconerosToMXmrDual } from '@/lib/format'
import MoneroPaymentView from './monero-payment-view'
import PaymentSuccessView from './payment-success-view'
import { useAnimation } from './animation'

const REPOST_FEE_POLL_MS = 10_000

const REPOST_FEE_STATUS = gql`
  query RepostFeeStatus($id: Int!) {
    payIn(id: $id) {
      id
      feeCovered
    }
  }
`

// RepostFeeModal — the fee attached to a turf repost (repostItem). A fee-bearing
// repost is deferred server-side (PendingItemUpdate): onBegin stores the turf
// addition and rewardsWalletObserver.flipPendingToLive applies it once the fee
// is observed. The modal polls PayIn.feeCovered — the same cumulative gate the
// observer settles on — and reports success only once the fee actually lands.
// Closing the QR without paying leaves the post in its current turfs (the
// pending addition is abandoned after FEE_ITEM_ABANDON_DAYS).
export default function RepostFeeModal ({ moneroUri, payInId, itemId, onClose }) {
  const router = useRouter()
  const animate = useAnimation()
  const [settled, setSettled] = useState(false)
  const feePiconeros = moneroUriAmountPiconeros(moneroUri) ?? 0n

  const { data } = useQuery(REPOST_FEE_STATUS, {
    variables: { id: Number(payInId) },
    skip: !payInId || settled,
    pollInterval: REPOST_FEE_POLL_MS
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
        title='Payment detected — your repost is going live!'
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
      heading='Pay the repost fee'
      description={`Scan to send ${piconerosToMXmrDual(feePiconeros)} to the turf's owner (or the platform rewards wallet for default turfs). Your post joins the new turf as soon as this fee is detected — it stays live in its current turfs.`}
    >
      <p className='text-muted text-center mt-3'>
        <small>
          Until it settles, the post stays live in its current turfs but is
          invisible in the new one. Closing this window leaves the repost
          unpaid — it is abandoned after a few days.
        </small>
      </p>
    </MoneroPaymentView>
  )
}
