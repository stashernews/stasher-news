import Link from 'next/link'
import { gql } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import { useEffect, useRef } from 'react'
import { useMe } from './me'
import { useAnimation } from './animation'
import { moneroUriAmountPiconeros, piconerosToMXmrDual, underpayHint } from '@/lib/format'
import { postingFeeModalPhase } from '@/lib/pay-in'
import MoneroPaymentView from './monero-payment-view'
import { REQUIRED_CONFIRMATIONS } from '@/lib/constants'

const POSTING_FEE_POLL_MS = 10_000

const ITEM_FEE_STATUS = `
  query ItemFeeStatus($id: ID!) {
    item(id: $id) { id feeStatus feeReceivedPiconeros feeTopUpUri }
  }
`

export default function PostingFeeModal ({ moneroUri, itemId, onPaid }) {
  const { me } = useMe()
  const animate = useAnimation()
  const expectedPiconeros = moneroUriAmountPiconeros(moneroUri) ??
    (me?.privates?.postingFeePiconeros ? BigInt(me.privates.postingFeePiconeros) : 0n)

  const { data } = useQuery(gql(ITEM_FEE_STATUS), {
    variables: { id: String(itemId) },
    skip: !itemId,
    pollInterval: itemId ? POSTING_FEE_POLL_MS : 0
  })

  const received = BigInt(data?.item?.feeReceivedPiconeros ?? 0)
  const phase = postingFeeModalPhase(data?.item?.feeStatus, received, expectedPiconeros)
  const hint = phase === 'waiting' ? underpayHint(received, expectedPiconeros) : null

  // Top-up URI: the server re-quotes only the REMAINDER after a partial fee
  // (Item.feeTopUpUri, mirrors territoryReentryFunding), so the QR + copyable
  // amount show what the user still owes instead of the full original fee. It
  // is null once the fee is fully OBSERVED (nothing left to pay) — the
  // 'detected' phase below renders the waiting state instead of a re-quote.
  // Falls back to the passed URI before the first poll resolves (a fresh submit
  // has nothing received, so the remainder equals the full fee).
  const displayUri = data?.item?.feeTopUpUri ?? moneroUri
  const displayPiconeros = moneroUriAmountPiconeros(displayUri) ?? expectedPiconeros

  // strike the lightning once the posting fee is detected on-chain
  // H2 (2026-09-26 review): the fee-gated publish only becomes durable now —
  // fire the caller's cleanup (server-draft deletion; the draft is the only
  // durable copy until the fee lands, because abandonFeeItems blanks the
  // unpaid PENDING_FEE item after 1 day). The ref keeps it exactly-once per
  // mount across poll re-renders and changing onPaid identities.
  const paidFiredRef = useRef(false)
  useEffect(() => {
    if (phase !== 'paid' || paidFiredRef.current) return
    paidFiredRef.current = true
    animate()
    onPaid?.()
  }, [phase, animate, onPaid])

  if (phase === 'paid') {
    return (
      <div className='d-flex flex-column align-items-center text-center'>
        <h6>Payment detected — your post is live!</h6>
        <Link href={`/items/${itemId}`} className='fw-bold text-decoration-underline'>
          view post
        </Link>
        <p className='text-muted mt-2'>
          <small>
            final confirmation takes about {REQUIRED_CONFIRMATIONS} blocks
          </small>
        </p>
      </div>
    )
  }

  // Fully observed but not yet chain-verified enough to flip: show the waiting
  // state, never a fresh QR for the full amount (the 2026-09-19 re-quote bug).
  if (phase === 'detected') {
    return (
      <div className='d-flex flex-column align-items-center text-center'>
        <h6>Payment detected — waiting for confirmation</h6>
        <p className='text-muted mt-2'>
          <small>
            {piconerosToMXmrDual(expectedPiconeros)} received. Your post goes live
            once the payment is confirmed on-chain (about {REQUIRED_CONFIRMATIONS} blocks).
          </small>
        </p>
      </div>
    )
  }

  return (
    <MoneroPaymentView
      moneroUri={displayUri}
      amountPiconeros={displayPiconeros}
      heading='Pay the posting fee'
      description={`Scan to send ${piconerosToMXmrDual(displayPiconeros)} to the platform rewards wallet. Your post goes live once the fee is detected on-chain.`}
    >
      {hint &&
        <p className='text-warning text-center mt-3'>
          <small>{hint}</small>
        </p>}
      <p className='text-muted text-center mt-3'>
        <small>
          Posting fees deter spam and fund curator rewards.
        </small>
      </p>
      <p className='text-muted text-center mt-3'>
        <small>
          Posts stay hidden until the fee lands — detection takes about one block.
        </small>
      </p>
    </MoneroPaymentView>
  )
}
