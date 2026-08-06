import Link from 'next/link'
import { gql } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import { useEffect } from 'react'
import { useMe } from './me'
import { useAnimation } from './animation'
import { moneroUriAmountPiconeros, piconerosToXmr } from '@/lib/format'
import { postingFeeModalPhase } from '@/lib/pay-in'
import MoneroPaymentView from './monero-payment-view'
import { REQUIRED_CONFIRMATIONS } from '@/lib/constants'

const POSTING_FEE_POLL_MS = 10_000

const ITEM_FEE_STATUS = `
  query ItemFeeStatus($id: ID!) {
    item(id: $id) { id feeStatus }
  }
`

export default function PostingFeeModal ({ moneroUri, itemId }) {
  const { me } = useMe()
  const animate = useAnimation()
  const feePiconeros = moneroUriAmountPiconeros(moneroUri) ??
    (me?.privates?.postingFeePiconeros ? BigInt(me.privates.postingFeePiconeros) : 0n)

  const { data } = useQuery(gql(ITEM_FEE_STATUS), {
    variables: { id: String(itemId) },
    skip: !itemId,
    pollInterval: itemId ? POSTING_FEE_POLL_MS : 0
  })

  const phase = postingFeeModalPhase(data?.item?.feeStatus)

  // strike the lightning once the posting fee is detected on-chain
  useEffect(() => {
    if (phase === 'paid') animate()
  }, [phase, animate])

  const canExplainPostingFee = !!me?.privates?.freePostMinAgeDays && !!me?.privates?.freePostThresholdPiconeros

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
      moneroUri={moneroUri}
      amountPiconeros={feePiconeros}
      heading='Pay the posting fee'
      description={`Scan to send ${piconerosToXmr(feePiconeros)} to the platform rewards wallet. Your post goes live once the fee is detected on-chain.`}
    >
      {canExplainPostingFee &&
        <p className='text-muted text-center mt-3'>
          <small>
            Posting fees deter spam. Posting is free once your account is {me.privates.freePostMinAgeDays} days old and you've earned {piconerosToXmr(BigInt(me.privates.freePostThresholdPiconeros))} in upvotes and tips.
          </small>
        </p>}
      <p className='text-muted text-center mt-3'>
        <small>
          Posts stay hidden until the fee lands — detection takes about one block.
        </small>
      </p>
    </MoneroPaymentView>
  )
}
