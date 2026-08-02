import Button from 'react-bootstrap/Button'
import BootstrapForm from 'react-bootstrap/Form'
import InputGroup from 'react-bootstrap/InputGroup'
import React, { useCallback, useState } from 'react'
import { useMutation, useApolloClient } from '@apollo/client/react'
import Qr from './qr'
import AccordianItem from './accordian-item'
import { useAnimation } from './animation'
import { useMe } from './me'
import { useToast } from './toast'
import { bumpActCache } from './item-act'
import useWatchTip from './tip/use-watch-tip'
import { INITIATE_TIP } from '@/fragments/monero'
import { xmrToPiconeros, piconerosToXmr } from '@/lib/format'
import UpBolt from '@/svgs/bolt.svg'

// StealthNews tip modal (spec §8.3). Mirrors components/downvote-modal.js: call a
// mutation, get a monero: URI, render a QR view. Differences from downvote:
//   - uses initiateTip (P2P, 100% to the author) not act/PayIn
//   - XMR-decimal amount entry (not a piconeros slider)
//   - polls tipStatus and bumps the item counter at DETECTED, then closes
const PRESETS = ['0.001', '0.01', '0.025']
const MIN_XMR = '0.0001' // = 1e8 piconeros, the server's minTipPiconeros floor

export default function TipModal ({ item, onClose }) {
  const client = useApolloClient()
  const { me } = useMe()
  const animate = useAnimation()
  const toaster = useToast()
  const [initiateTip] = useMutation(INITIATE_TIP)
  const [amount, setAmount] = useState('')
  const [tip, setTip] = useState(null) // { uri, paymentId, piconeros }

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
      const { uri, paymentId } = data.initiateTip
      setTip({ uri, paymentId, piconeros: String(piconeros) })
    } catch (error) {
      // e.g. "post author has no monero account", "min tip is 0.0001 XMR ..."
      toaster.danger(error?.message ?? 'failed to create tip')
    }
  }, [initiateTip, amount, item.id, toaster])

  const onDetected = useCallback(() => {
    // bump the item counter optimistically (sats = floor(piconeros/1000)); refetch reconciles
    const sats = Number(BigInt(tip.piconeros) / 1000n)
    bumpActCache(client.cache, { id: item.id, sats, act: 'TIP', path: item.path }, me)
    animate()
    onClose?.()
  }, [client, tip, item.id, item.path, me, animate, onClose])

  if (tip) {
    return (
      <TipPaymentView
        uri={tip.uri} paymentId={tip.paymentId} amount={tip.piconeros} onDetected={onDetected}
      />
    )
  }

  return (
    <div className='d-flex flex-column'>
      <h6 className='text-start'>Tip</h6>
      <p className='text-muted text-start'>
        100% of this tip goes directly to the author, wallet-to-wallet.
      </p>

      <BootstrapForm.Group className='my-2'>
        <div className='d-flex justify-content-between align-items-baseline'>
          <BootstrapForm.Label className='mb-0'>amount</BootstrapForm.Label>
          <span className='text-monospace'>{amount && piconerosToXmr(xmrToPiconerosSafe(amount))}</span>
        </div>
        <InputGroup>
          <BootstrapForm.Control
            type='number'
            min={MIN_XMR}
            step='0.0001'
            placeholder='0.001'
            value={amount}
            onChange={e => setAmount(e.target.value)}
            autoFocus
          />
          <InputGroup.Text className='text-monospace'>XMR</InputGroup.Text>
        </InputGroup>
      </BootstrapForm.Group>

      <div className='d-flex flex-wrap gap-2 my-2'>
        {PRESETS.map(p => (
          <Button
            key={p}
            size='sm'
            variant={amount === p ? 'success' : 'outline-success'}
            onClick={() => setAmount(p)}
          >
            <UpBolt className='me-1' width={14} height={14} />{p}
          </Button>
        ))}
      </div>

      <div className='d-flex mt-3'>
        <Button variant='success' className='ms-auto px-4' onClick={onSubmit}>
          generate tip
        </Button>
      </div>

      <AccordianItem
        header='how do tips work?' body={
          <ul className='text-muted'>
            <li>your tip goes directly to the author's Monero wallet — StealthNews never holds it</li>
            <li>after you pay, the tip is detected within ~2 minutes (one stagenet block)</li>
            <li>the post's tip counter updates the moment your payment is detected</li>
          </ul>
        }
      />
    </div>
  )
}

// render-time helper: show the XMR equivalent only when the input parses
function xmrToPiconerosSafe (amount) {
  try { return xmrToPiconeros(amount) } catch { return 0n }
}

function tipStatusCopy (state) {
  switch (state) {
    case 'EXPIRED':
      return 'this tip expired before it was detected — try again'
    case 'REORGED':
      return 'the payment was detected then reorganized — try again'
    case 'CONFIRMED':
      return 'status: CONFIRMED'
    default: {
      // DETECTED bumps + closes via onDetected; PENDING/null keeps the waiting copy
      const label = state ?? 'PENDING'
      return `status: ${label} — waiting for your payment (usually < 2 min)`
    }
  }
}

function TipPaymentView ({ uri, paymentId, amount, onDetected }) {
  const { state } = useWatchTip({ paymentId, onDetected })
  return (
    <div className='d-flex flex-column align-items-center'>
      <h6>Pay this tip</h6>
      <p className='text-muted text-center'>
        Scan to send {piconerosToXmr(BigInt(amount))} directly to the author.
      </p>
      <Qr value={uri} />
      <div className='mt-2'>
        <a href={uri} className='fw-bold text-decoration-underline'>Open in Cake Wallet</a>
      </div>
      <p className='text-muted text-center mt-2'>
        <small>{tipStatusCopy(state)}</small>
      </p>
    </div>
  )
}
