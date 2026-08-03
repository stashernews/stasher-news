import { useMe } from './me'
import { moneroUriAmountPiconeros, piconerosToXmr } from '@/lib/format'
import MoneroPaymentView from './monero-payment-view'

export default function PostingFeeModal ({ moneroUri, itemId }) {
  const { me } = useMe()
  const feePiconeros = moneroUriAmountPiconeros(moneroUri) ??
    (me?.privates?.postingFeePiconeros ? BigInt(me.privates.postingFeePiconeros) : 0n)

  return (
    <MoneroPaymentView
      moneroUri={moneroUri}
      amountPiconeros={feePiconeros}
      heading='Pay the posting fee'
      description={`Scan to send ${piconerosToXmr(feePiconeros)} to the platform rewards wallet. Your post goes live once the fee is detected on-chain.`}
    >
      <p className='text-muted text-center mt-3'>
        <small>
          Posts stay hidden until the fee lands — detection takes about one block.
        </small>
      </p>
    </MoneroPaymentView>
  )
}
