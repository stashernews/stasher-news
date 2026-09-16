import Button from 'react-bootstrap/Button'
import BootstrapForm from 'react-bootstrap/Form'
import React, { useCallback, useState } from 'react'
import AccordianItem from './accordian-item'
import MoneroPaymentView from './monero-payment-view'
import PaymentSuccessView from './payment-success-view'
import useWatchDownvote from './downvote/use-watch-downvote'
import { useAct } from './item-act'
import { useAnimation } from './animation'
import { useToast } from './toast'
import { piconerosToMXmr, piconerosToMXmrDual } from '@/lib/format'
import { shouldTriggerPaymentSuccess } from '@/lib/pay-in'
import Flag from '@/svgs/flag-fill.svg'
import {
  DOWNVOTE_MIN_PICONEROS,
  DOWNVOTE_DEFAULT_PICONEROS,
  DOWNVOTE_MAX_PICONEROS,
  DOWNVOTE_STEP_PICONEROS,
  downvoteAmountError,
  isLargeDownvote
} from '@/lib/downvote'

// preset quick amounts (piconeros) — mirrors the tip presets (0.001 / 0.01 / 0.025 XMR)
const PRESETS = [
  1_000_000_000, // 0.001 XMR
  10_000_000_000, // 0.01 XMR
  25_000_000_000 // 0.025 XMR
]

// StealthNews downvote modal (spec §6.9).
//
// A downvote pays a fee-sized Monero amount to the platform rewards wallet via
// an integrated address. `act('DONT_LIKE_THIS')` calls pay('DOWN_ZAP'), which —
// with mcost=0n — resolves to payInState=PAID at creation and returns a `monero:`
// URI straight away (no invoice to watch). We render that URI as a QR + deep
// link; the on-chain payment is observed separately by the rewardsWalletObserver, which
// applies the ranking penalty when it lands (~one stagenet block).
export default function DownvoteModal ({ item, onClose }) {
  const actor = useAct()
  const toaster = useToast()
  const animate = useAnimation()
  const [amount, setAmount] = useState(DOWNVOTE_DEFAULT_PICONEROS)
  const [moneroUri, setMoneroUri] = useState(null)
  const [paymentId, setPaymentId] = useState(null)
  const [downvotePaid, setDownvotePaid] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const onSubmit = useCallback(async (e) => {
    e?.preventDefault?.()
    // enforce the piconeros floor client-side (backend re-checks via downZap.getInitial)
    const err = downvoteAmountError(amount)
    if (err) {
      toaster.danger(err)
      return
    }
    setSubmitting(true)
    try {
      const res = await actor({ variables: { id: item.id, piconeros: amount, act: 'DONT_LIKE_THIS' } })
      const uri = res?.data?.act?.moneroUri
      const paymentId = res?.data?.act?.paymentId
      if (!uri) throw new Error('downvote returned no monero URI')
      setMoneroUri(uri)
      setPaymentId(paymentId ?? null)
    } catch (error) {
      toaster.danger('failed to create downvote')
    } finally {
      setSubmitting(false)
    }
  }, [actor, amount, item.id, toaster])

  if (downvotePaid) {
    return (
      <PaymentSuccessView
        title='Payment detected — your downvote is on its way!'
        autoCloseMs={5000}
        onAutoClose={onClose}
      />
    )
  }

  if (moneroUri) {
    return (
      <DownvotePaymentView
        moneroUri={moneroUri} amount={amount} paymentId={paymentId}
        onDetected={() => { animate(); setDownvotePaid(true) }} onClose={onClose}
      />
    )
  }

  const large = isLargeDownvote(amount)

  return (
    <div className='d-flex flex-column'>
      <h6 className='text-start'>Downvote</h6>

      <BootstrapForm.Group className='my-2'>
        <div className='d-flex justify-content-between align-items-baseline'>
          <BootstrapForm.Label className='mb-0'>amount</BootstrapForm.Label>
          <span className='text-monospace'>{piconerosToMXmr(BigInt(amount))}</span>
        </div>
        <BootstrapForm.Range
          min={DOWNVOTE_MIN_PICONEROS}
          max={DOWNVOTE_MAX_PICONEROS}
          step={DOWNVOTE_STEP_PICONEROS}
          value={amount}
          onChange={e => setAmount(Number(e.target.value))}
        />
        <div className='d-flex justify-content-end'>
          <small className='text-muted text-monospace'>{amount.toLocaleString()} piconeros</small>
        </div>
        {large &&
          <div className='mt-1 text-muted'>
            <small>large downvote</small>
          </div>}
      </BootstrapForm.Group>

      <div className='d-flex flex-wrap gap-2 my-2'>
        {PRESETS.map(p => (
          <Button
            key={p}
            size='sm'
            variant={amount === p ? 'danger' : 'outline-danger'}
            onClick={() => setAmount(p)}
          >
            <Flag
              className='me-1'
              width={14}
              height={14}
            />{piconerosToMXmr(BigInt(p))}
          </Button>
        ))}
      </div>

      <div className='d-flex mt-3'>
        <Button
          variant='danger'
          className='ms-auto px-4'
          disabled={submitting}
          onClick={onSubmit}
        >
          {submitting ? 'generating…' : 'downvote'}
        </Button>
      </div>

      <AccordianItem
        header='what is a downvote?' body={
          <ul className='text-muted'>
            <li>Downvoting de-ranks the post proportionally to the amount paid</li>
            <li>the monero paid to downvote funds the weekly curator rewards pool</li>
            <li>the ranking penalty applies once your payment is observed on-chain (~2 minutes)</li>
          </ul>
        }
      />
    </div>
  )
}

function DownvotePaymentView ({ moneroUri, amount, paymentId, onDetected, onClose }) {
  const { state } = useWatchDownvote({ paymentId, onDetected })
  const statusCopy = downvoteStatusCopy(state)

  // Render the success view directly from the polled state (mirrors the posting-fee
  // modal, which derives its paid phase straight from the query data). This does not
  // depend on the onDetected callback reaching the parent, so a detection can never
  // be missed while the modal is open.
  if (shouldTriggerPaymentSuccess(state)) {
    return (
      <PaymentSuccessView
        title='Payment detected — your downvote is on its way!'
        autoCloseMs={5000}
        onAutoClose={onClose}
      />
    )
  }

  return (
    <MoneroPaymentView
      moneroUri={moneroUri}
      amountPiconeros={BigInt(amount)}
      heading='Pay this downvote'
      description={`Scan to send ${piconerosToMXmrDual(BigInt(amount))} to the rewards pool.`}
    >
      {statusCopy &&
        <p className='text-muted text-center mt-3'>
          <small>{statusCopy}</small>
        </p>}
    </MoneroPaymentView>
  )
}

export function downvoteStatusCopy (state) {
  switch (state) {
    case 'EXPIRED':
      return 'this downvote expired before it was detected — try again'
    case 'REORGED':
      return 'the payment was detected then reorganized — try again'
    default:
      // DETECTED/CONFIRMED flip to the success view; PENDING/null shows no status line
      return null
  }
}
