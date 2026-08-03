import { useCallback } from 'react'
import { InvoiceCanceledError } from '@/wallets/client/errors'
import { useShowModal } from '@/components/modal'
import useWatchPayIn from './use-watch-pay-in'
import { QrSkeleton } from '@/components/qr'
import PayInError from '../error'
import { paidWaitFor } from '@/lib/pay-in'
import { PayInStatus } from '../status'

export default function useQrPayIn () {
  const showModal = useShowModal()

  const waitForQrPayIn = useCallback(async (payIn, walletError,
    {
      keepOpen = true,
      cancelOnClose = true,
      persistOnNavigate = false,
      waitFor = paidWaitFor
    } = {}
  ) => {
    // The Lightning bolt11 QR invoice was removed with the Bolt11 surface — Monero payments are
    // observed server-side via webhooks, so there is no invoice to render. The modal keeps polling
    // the payIn state and resolves when it reaches the settled state.
    return await new Promise((resolve, reject) => {
      let updatedPayIn
      const cancelAndReject = () => {
        if (!updatedPayIn && cancelOnClose) {
          reject(new InvoiceCanceledError(payIn.id))
          return
        }
        resolve(updatedPayIn)
      }
      showModal(onClose =>
        <QrPayIn
          id={payIn.id}
          walletError={walletError}
          waitFor={waitFor}
          onPaymentError={err => {
            onClose()
            reject(err)
          }}
          onPaymentSuccess={(paidPayIn) => {
            updatedPayIn = paidPayIn
            // this onClose will resolve the promise before the subsequent line runs
            // so we need to set updatedPayIn first
            onClose()
            resolve(paidPayIn)
          }}
        />,
      { keepOpen, persistOnNavigate, onClose: cancelAndReject })
    })
  }, [showModal])

  return waitForQrPayIn
}

function QrPayIn ({
  id, onPaymentError, onPaymentSuccess, waitFor, walletError
}) {
  const { data, error } = useWatchPayIn({ id, onPaymentError, onPaymentSuccess, waitFor })

  if (error) {
    return <div>{error.message}</div>
  }

  return (
    <>
      <PayInError error={walletError} />
      <QrSkeleton description />
      <div className='d-flex justify-content-center'>
        <PayInStatus payIn={data?.payIn} />
      </div>
    </>
  )
}
