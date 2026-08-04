import Button from 'react-bootstrap/Button'
import BootstrapForm from 'react-bootstrap/Form'
import React, { useCallback, useState } from 'react'
import AccordianItem from './accordian-item'
import MoneroPaymentView from './monero-payment-view'
import { useAct } from './item-act'
import { useToast } from './toast'
import { piconerosToXmr } from '@/lib/format'
import Flag from '@/svgs/flag-fill.svg'
import {
  DOWNVOTE_MIN_PICONEROS,
  DOWNVOTE_DEFAULT_PICONEROS,
  DOWNVOTE_MAX_PICONEROS,
  DOWNVOTE_STEP_PICONEROS,
  downvoteAmountError,
  isLargeDownvote
} from '@/lib/downvote'

// preset quick amounts (piconeros) — mirrors the Tips row in item-act.js
const PRESETS = [
  DOWNVOTE_MIN_PICONEROS, // 0.0001 XMR
  500_000_000, // 0.0005 XMR
  DOWNVOTE_DEFAULT_PICONEROS, // 0.001 XMR
  DOWNVOTE_MAX_PICONEROS // 0.002 XMR
]

// StealthNews downvote modal (spec §6.9).
//
// A downvote pays a fee-sized Monero amount to the platform rewards wallet via
// an integrated address. `act('DONT_LIKE_THIS')` calls pay('DOWN_ZAP'), which —
// with mcost=0n — resolves to payInState=PAID at creation and returns a `monero:`
// URI straight away (no invoice to watch). We render that URI as a QR + deep
// link; the on-chain payment is observed separately by the penaltyIndexer, which
// applies the ranking penalty when it lands (~one stagenet block).
export default function DownvoteModal ({ item, onClose }) {
  const actor = useAct()
  const toaster = useToast()
  const [amount, setAmount] = useState(DOWNVOTE_DEFAULT_PICONEROS)
  const [moneroUri, setMoneroUri] = useState(null)
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
      if (!uri) throw new Error('downvote returned no monero URI')
      setMoneroUri(uri)
    } catch (error) {
      toaster.danger('failed to create downvote')
    } finally {
      setSubmitting(false)
    }
  }, [actor, amount, item.id, toaster])

  if (moneroUri) {
    return <DownvotePaymentView moneroUri={moneroUri} amount={amount} onClose={onClose} />
  }

  const large = isLargeDownvote(amount)

  return (
    <div className='d-flex flex-column'>
      <h6 className='text-start'>Downvote</h6>
      <p className='text-muted text-start'>
        Downvotes fund the weekly curator rewards pool. The poster is not charged.
      </p>

      <BootstrapForm.Group className='my-2'>
        <div className='d-flex justify-content-between align-items-baseline'>
          <BootstrapForm.Label className='mb-0'>amount</BootstrapForm.Label>
          <span className='text-monospace'>{piconerosToXmr(BigInt(amount))}</span>
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
            />{piconerosToXmr(BigInt(p))}
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
            <li>your Monero payment funds the weekly curator rewards pool</li>
            <li>the poster is never charged</li>
            <li>the ranking penalty applies once your payment is observed on-chain (~2 minutes)</li>
          </ul>
        }
      />
    </div>
  )
}

function DownvotePaymentView ({ moneroUri, amount }) {
  // TODO(v1.1): live DETECTED→CONFIRMED pill — the PayIn is PAID at creation and the
  // on-chain observation is tracked in ObservedBurn (not linked back to this PayIn),
  // so there is no clean PayIn-state transition to poll in v1.
  return (
    <MoneroPaymentView
      moneroUri={moneroUri}
      amountPiconeros={BigInt(amount)}
      heading='Pay this downvote'
      description={`Scan to send ${piconerosToXmr(BigInt(amount))} to the rewards pool.`}
    >
      <p className='text-muted text-center mt-3'>
        <small>
          After you pay, the downvote is detected within ~2 minutes (one stagenet block).
        </small>
      </p>
    </MoneroPaymentView>
  )
}
