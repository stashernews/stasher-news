import Button from 'react-bootstrap/Button'
import BootstrapForm from 'react-bootstrap/Form'
import InputGroup from 'react-bootstrap/InputGroup'
import React, { useCallback, useState } from 'react'
import { useMutation, useApolloClient } from '@apollo/client/react'
import AccordianItem from './accordian-item'
import { defaultTipIncludingRandom } from './upvote'
import MoneroPaymentView from './monero-payment-view'
import { useAnimation } from './animation'
import { useMe } from './me'
import { useToast } from './toast'
import { bumpActCache } from './item-act'
import PaymentSuccessView from './payment-success-view'
import useWatchTip from './tip/use-watch-tip'
import { INITIATE_TIP } from '@/fragments/monero'
import { USER_ID } from '@/lib/constants'
import { xmrToPiconeros, piconerosToXmrDecimal, piconerosToMXmr, piconerosToMXmrDual } from '@/lib/format'
import MXmrHint from './mxmr-hint'
import { shouldTriggerPaymentSuccess } from '@/lib/pay-in'
import { DISPLAY_FONT } from '@/lib/rebrand'
import UpArrow from '@/svgs/up-arrow.svg'

// StealthNews tip modal (spec §8.3). Mirrors components/downvote-modal.js: call a
// mutation, get a monero: URI, render a QR view. Differences from downvote:
//   - uses initiateTip (P2P, 100% to the author) not act/PayIn
//   - XMR-decimal amount entry (not a piconeros slider)
//   - polls tipStatus and bumps the item counter at DETECTED, then closes

// The amount the modal opens prefilled with: the user's saved default, or a
// fresh random within range when random tips are on (lazy useState init runs on
// each modal open, so every open rolls the dice). Fallback 1e9 = 0.001 XMR.
export const initialTipAmount = (privates) =>
  piconerosToXmrDecimal(BigInt(defaultTipIncludingRandom(privates) || 1000000000))

const PRESETS = ['0.0005', '0.001', '0.005', '0.01']
const MIN_XMR = '0.0001' // = 1e8 piconeros, the server's minTipPiconeros floor
// quick-slider bounds (XMR): 0.0005–0.025 in 0.0005 steps, in piconeros
const TIP_SLIDER_MIN = 500000000n
const TIP_SLIDER_MAX = 25000000000n
const TIP_SLIDER_STEP = 500000000n

// Unlock mode reuses the tip flow for monerowall unlocks: `fixedAmount`
// (piconeros) locks the amount to the wall price and hides presets/random,
// `unlockMode` swaps the copy after detection — entitlement lands at DETECTED
// (0-conf), so the success view reports the post as open while confirmation
// continues in the background. `onDetected` is an optional unlock-mode
// callback for the caller behind the modal (the wall panel refetches to
// unlock); normal tips never pass it.
export default function TipModal ({ item, onClose, fixedAmount, unlockMode, onDetected }) {
  const client = useApolloClient()
  const { me } = useMe()
  const animate = useAnimation()
  const toaster = useToast()
  const [initiateTip] = useMutation(INITIATE_TIP)
  const fixedPiconeros = fixedAmount != null ? BigInt(fixedAmount) : null
  const [amount, setAmount] = useState(() => fixedPiconeros != null
    ? piconerosToXmrDecimal(fixedPiconeros)
    : initialTipAmount(me?.privates))
  const [tip, setTip] = useState(null) // { uri, paymentId, piconeros, recipient }
  const authorIsAnon = Number(item?.user?.id) === USER_ID.anon
  const [tipPaid, setTipPaid] = useState(false)

  const onSubmit = useCallback(async (e) => {
    e?.preventDefault?.()
    let piconeros
    try {
      piconeros = xmrToPiconeros(amount)
    } catch (err) {
      toaster.danger('enter a valid XMR amount (min 0.0001)')
      return
    }
    try {
      const { data } = await initiateTip({ variables: { postId: String(item.id), amount: String(piconeros) } })
      const { uri, paymentId, recipient } = data.initiateTip
      setTip({ uri, paymentId, piconeros: String(piconeros), recipient })
    } catch (error) {
      // e.g. "post author has no monero account", "min tip is 0.0001 XMR ..."
      toaster.danger(error?.message ?? 'failed to create tip')
    }
  }, [initiateTip, amount, item.id, toaster])

  const handleDetected = useCallback(() => {
    // Transition to the success state FIRST so a cosmetic side-effect below
    // (cache bump / animation) can never prevent the success view or auto-close.
    setTipPaid(true)
    // bump the item counter optimistically with the true piconeros; refetch reconciles
    const piconeros = Number(BigInt(tip.piconeros))
    bumpActCache(client.cache, { id: item.id, piconeros, act: 'TIP', path: item.path }, me)
    animate()
    // Unlock mode: tell the panel a payment was detected — its refetch (and
    // this one) re-queries entitlement, which counts DETECTED tips (0-conf),
    // so the wall behind the modal unlocks now; confirmation continues in the
    // background.
    if (unlockMode) {
      onDetected?.()
      client.refetchQueries({ include: ['Item'] }).catch(() => {})
    }
  }, [client, tip, item.id, item.path, me, animate, unlockMode, onDetected])

  if (tipPaid) {
    return (
      <PaymentSuccessView
        {...successViewProps(unlockMode)}
        autoCloseMs={5000}
        onAutoClose={onClose}
      />
    )
  }

  if (tip) {
    return (
      <TipPaymentView
        uri={tip.uri} paymentId={tip.paymentId} amount={tip.piconeros} recipient={tip.recipient} onDetected={handleDetected} onClose={onClose} unlockMode={unlockMode}
      />
    )
  }

  return (
    <div className='d-flex flex-column'>
      <h6 className='text-start' style={{ fontFamily: DISPLAY_FONT }}>{unlockMode ? 'Unlock this post' : 'Tip'}</h6>
      <p className='text-muted text-start'>
        {authorIsAnon
          ? <>This author has no wallet. Your tip up-ranks the post and funds the curator rewards pool.</>
          : unlockMode
            ? <>100% of this unlock goes directly to the author, wallet-to-wallet.</>
            : <>100% of this tip goes directly to the author, wallet-to-wallet.</>}
      </p>

      <BootstrapForm.Group className='my-2'>
        <div className='d-flex justify-content-between align-items-baseline'>
          <BootstrapForm.Label className='mb-0'>amount</BootstrapForm.Label>
          <span className='text-monospace'>{amount && piconerosToMXmrDual(xmrToPiconerosSafe(amount))}</span>
        </div>
        <InputGroup>
          <BootstrapForm.Control
            type='number'
            min={MIN_XMR}
            step='0.0001'
            placeholder='0.001'
            value={amount}
            onChange={e => setAmount(e.target.value)}
            disabled={fixedPiconeros != null}
            autoFocus
          />
          <InputGroup.Text className='text-monospace'>XMR</InputGroup.Text>
        </InputGroup>
        <MXmrHint value={amount} />
        {fixedPiconeros == null &&
          <BootstrapForm.Range
            className='mt-2'
            min={Number(TIP_SLIDER_MIN)}
            max={Number(TIP_SLIDER_MAX)}
            step={Number(TIP_SLIDER_STEP)}
            value={Math.min(Number(TIP_SLIDER_MAX), Math.max(Number(TIP_SLIDER_MIN), Number(xmrToPiconerosSafe(amount))))}
            onChange={e => setAmount(piconerosToXmrDecimal(BigInt(e.target.value)))}
          />}
      </BootstrapForm.Group>

      {fixedPiconeros == null &&
        <div className='d-flex flex-wrap gap-2 my-2'>
          {PRESETS.map(p => (
            <Button
              key={p}
              size='sm'
              variant={amount === p ? 'primary' : 'outline-primary'}
              onClick={() => setAmount(p)}
            >
              <UpArrow className='me-1' width={14} height={14} />{piconerosToMXmr(xmrToPiconeros(p))}
            </Button>
          ))}
        </div>}

      <div className='d-flex mt-3'>
        <Button variant='primary' className='ms-auto px-4' onClick={onSubmit}>
          {unlockMode ? 'unlock' : 'generate tip'}
        </Button>
      </div>

      <AccordianItem
        header={
          <span style={{ fontFamily: DISPLAY_FONT }}>how do tips work?</span>
        }
        body={
          <ul className='text-muted'>
            <li>your tip goes directly to the author's Monero wallet — Stasher News never holds it</li>
            <li>after you pay, the tip is detected within ~2 minutes (one stagenet block)</li>
            <li>the post's tip counter updates the moment your payment is detected</li>
          </ul>
        }
      />
    </div>
  )
}

// render-time helper: show the amounts only when the input parses
function xmrToPiconerosSafe (amount) {
  try { return xmrToPiconeros(amount) } catch { return 0n }
}

export function tipStatusCopy (state) {
  switch (state) {
    case 'EXCLUDED':
      return 'this tip was not counted (self-tip)'
    case 'EXPIRED':
      return 'this tip expired before it was detected — try again'
    case 'REORGED':
      return 'the payment was detected then reorganized — try again'
    default:
      // DETECTED/CONFIRMED flip to the success view; PENDING/null shows no status line
      return null
  }
}

// Success copy for both the callback-driven and poll-driven success paths.
// Unlock mode sets 0-conf expectations (2026-09-22 spec): the wall's refetch
// grants entitlement at DETECTED, so the post is already open behind the modal
// when this view shows — confirmation merely continues in the background. A
// sub-price contribution counts immediately too, and unlocks the post the
// moment the running total covers the price.
function successViewProps (unlockMode) {
  return unlockMode
    ? {
        title: 'Payment detected — confirming…',
        note: 'your post unlocks the moment your total covers the price — confirmation finishes in the background'
      }
    : { title: 'Payment detected — your tip is on its way!' }
}

function TipPaymentView ({ uri, paymentId, amount, recipient, onDetected, onClose, unlockMode }) {
  const { state } = useWatchTip({ paymentId, onDetected })
  const statusCopy = tipStatusCopy(state)
  // Render the success view directly from the polled state (mirrors the posting-fee
  // modal, which derives its paid phase straight from the query data). This does not
  // depend on the onDetected callback reaching the parent, so a detection can never
  // be missed while the modal is open.
  if (shouldTriggerPaymentSuccess(state)) {
    return (
      <PaymentSuccessView
        {...successViewProps(unlockMode)}
        autoCloseMs={5000}
        onAutoClose={onClose}
      />
    )
  }
  return (
    <MoneroPaymentView
      moneroUri={uri}
      amountPiconeros={BigInt(amount)}
      heading={unlockMode ? 'Pay to unlock' : 'Pay this tip'}
      description={recipient === 'REWARDS'
        ? `Scan to send ${piconerosToMXmrDual(BigInt(amount))} to the rewards pool — the author has no Monero wallet.`
        : `Scan to send ${piconerosToMXmrDual(BigInt(amount))} directly to the author.`}
    >
      {statusCopy &&
        <p className='text-muted text-center mt-2'>
          <small>{statusCopy}</small>
        </p>}
    </MoneroPaymentView>
  )
}
