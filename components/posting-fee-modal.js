import React from 'react'
import Qr from './qr'
import { useMe } from './me'
import { piconerosToXmr } from '@/lib/format'

export default function PostingFeeModal ({ moneroUri }) {
  const { me } = useMe()
  const feePiconeros = me?.privates?.postingFeePiconeros
    ? BigInt(me.privates.postingFeePiconeros)
    : 0n

  return (
    <div className='d-flex flex-column align-items-center'>
      <h6>Pay the posting fee</h6>
      <p className='text-muted text-center'>
        Scan to send {piconerosToXmr(feePiconeros)} to the platform rewards wallet.
        Your post goes live once the fee is detected on-chain.
      </p>
      <Qr value={moneroUri} />
      <div className='mt-2'>
        <a href={moneroUri} className='fw-bold text-decoration-underline'>Open in Cake Wallet</a>
      </div>
      <p className='text-muted text-center mt-3'>
        <small>
          Posts stay hidden until the fee lands — detection takes about one block.
        </small>
      </p>
    </div>
  )
}
