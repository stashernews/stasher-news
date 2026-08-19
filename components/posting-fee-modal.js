import Link from 'next/link'
import { gql } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import { useEffect } from 'react'
import { useMe } from './me'
import { useAnimation } from './animation'
import { moneroUriAmountPiconeros, piconerosToXmr, underpayHint } from '@/lib/format'
import { postingFeeModalPhase } from '@/lib/pay-in'
import MoneroPaymentView from './monero-payment-view'
import { REQUIRED_CONFIRMATIONS } from '@/lib/constants'

const POSTING_FEE_POLL_MS = 10_000

const ITEM_FEE_STATUS = `
  query ItemFeeStatus($id: ID!) {
    item(id: $id) { id feeStatus feeReceivedPiconeros feeTopUpUri }
  }
`

export default function PostingFeeModal ({ moneroUri, itemId }) {
  const { me } = useMe()
  const animate = useAnimation()
  const expectedPiconeros = moneroUriAmountPiconeros(moneroUri) ??
    (me?.privates?.postingFeePiconeros ? BigInt(me.privates.postingFeePiconeros) : 0n)

  const { data } = useQuery(gql(ITEM_FEE_STATUS), {
    variables: { id: String(itemId) },
    skip: !itemId,
    pollInterval: itemId ? POSTING_FEE_POLL_MS : 0
  })

  const phase = postingFeeModalPhase(data?.item?.feeStatus)

  const received = BigInt(data?.item?.feeReceivedPiconeros ?? 0)
  const hint = phase !== 'paid' ? underpayHint(received, expectedPiconeros) : null

  // Top-up URI: the server re-quotes only the REMAINDER after a partial fee
  // (Item.feeTopUpUri, mirrors territoryReentryFunding), so the QR + copyable
  // amount show what the user still owes instead of the full original fee. The
  // stored URI is never rewritten, so the observer gate keeps gating on the full
  // amount. Falls back to the passed URI before the first poll resolves (a
  // fresh submit has nothing received, so the remainder equals the full fee).
  const displayUri = data?.item?.feeTopUpUri ?? moneroUri
  const displayPiconeros = moneroUriAmountPiconeros(displayUri) ?? expectedPiconeros

  // strike the lightning once the posting fee is detected on-chain
  useEffect(() => {
    if (phase === 'paid') animate()
  }, [phase, animate])

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

  return (
    <MoneroPaymentView
      moneroUri={displayUri}
      amountPiconeros={displayPiconeros}
      heading='Pay the posting fee'
      description={`Scan to send ${piconerosToXmr(displayPiconeros)} to the platform rewards wallet. Your post goes live once the fee is detected on-chain.`}
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
