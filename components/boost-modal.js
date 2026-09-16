import Button from 'react-bootstrap/Button'
import BootstrapForm from 'react-bootstrap/Form'
import React, { useCallback, useEffect, useState } from 'react'
import { gql } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import AccordianItem from './accordian-item'
import MoneroPaymentView from './monero-payment-view'
import PaymentSuccessView from './payment-success-view'
import { useAct } from './item-act'
import { useAnimation } from './animation'
import { useToast } from './toast'
import { piconerosToMXmr, piconerosToMXmrDual, xmrToPiconeros } from '@/lib/format'
import BoostIcon from '@/svgs/arrow-up-double-line.svg'
import MXmrHint from './mxmr-hint'

const PRESETS = ['0.001', '0.01', '0.1', '1']

const BOOST_POLL_MS = 5000

const PAY_IN_QUERY = gql`
  query PayIn($id: Int!) {
    payIn(id: $id) {
      id
      feeObserved
    }
  }
`

export default function BoostModal ({ item, onClose }) {
  const actor = useAct()
  const toaster = useToast()
  const animate = useAnimation()
  const [amount, setAmount] = useState('0.001')
  const [piconeros, setPiconeros] = useState(null)
  const [moneroUri, setMoneroUri] = useState(null)
  const [payInId, setPayInId] = useState(null)
  const [boostPaid, setBoostPaid] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const onSubmit = useCallback(async (e) => {
    e?.preventDefault?.()
    // the act mutation validates piconeros as an integer (actSchema boostValidator),
    // so convert the decimal XMR input to piconeros before sending (mirrors item-act.js)
    let piconeros
    try {
      piconeros = Number(xmrToPiconeros(String(amount)))
    } catch {
      toaster.danger('enter a valid XMR amount (min 0.001)')
      return
    }
    setSubmitting(true)
    try {
      const res = await actor({ variables: { id: item.id, piconeros, act: 'BOOST' } })
      const uri = res?.data?.act?.moneroUri
      const id = res?.data?.act?.id
      if (!uri) {
        throw new Error('boost did not return a payment URI')
      }
      setPiconeros(piconeros)
      setMoneroUri(uri)
      setPayInId(id)
    } catch (error) {
      toaster.danger(error.message || 'failed to boost item')
    } finally {
      setSubmitting(false)
    }
  }, [actor, item.id, amount, toaster])

  // Poll the PayIn's feeObserved flag: the rewardsWalletObserver records the
  // FeeObservation('BOOST') once the payment lands on-chain.
  const { data } = useQuery(PAY_IN_QUERY, {
    variables: { id: payInId },
    skip: !payInId || boostPaid,
    pollInterval: BOOST_POLL_MS
  })
  const observed = data?.payIn?.feeObserved === true

  useEffect(() => {
    if (!observed || boostPaid) return
    setBoostPaid(true)
    animate()
  }, [observed, boostPaid, animate])

  if (boostPaid) {
    return (
      <PaymentSuccessView
        title='Payment detected — your boost is on its way!'
        autoCloseMs={1500}
        onAutoClose={onClose}
      />
    )
  }

  return (
    <div className='p-3'>
      <h5 className='fw-bold text-center'>boost this item</h5>
      {!moneroUri
        ? (
          <BootstrapForm onSubmit={onSubmit}>
            <div className='d-flex gap-2 justify-content-center mb-2 flex-wrap'>
              {PRESETS.map(num =>
                <Button size='sm' key={num} onClick={() => setAmount(num)}>{piconerosToMXmr(xmrToPiconeros(num))}</Button>)}
            </div>
            <BootstrapForm.Group>
              <BootstrapForm.Control
                type='text'
                inputMode='decimal'
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder='XMR amount'
              />
              <MXmrHint value={amount} />
            </BootstrapForm.Group>
            <div className='d-flex justify-content-end gap-2 mt-3'>
              <Button variant='secondary' onClick={onClose}>cancel</Button>
              <Button type='submit' disabled={submitting}>
                <BoostIcon width={16} height={16} className='me-1' />boost
              </Button>
            </div>
          </BootstrapForm>
          )
        : (
          <MoneroPaymentView
            moneroUri={moneroUri}
            amountPiconeros={BigInt(piconeros)}
            heading='Pay this boost'
            description={`Scan to send ${piconerosToMXmrDual(BigInt(piconeros))} to the platform wallet. 30% funds the weekly curator rewards.`}
          >
            <p className='text-muted text-center mt-3'>
              <small>
                Boost ranks this item higher like a tip. Detection takes about one block; final confirmation takes a few more.
              </small>
            </p>
          </MoneroPaymentView>
          )}
      <AccordianItem header='what is boost?' body={<BoostHelp />} />
    </div>
  )
}

export function BoostHelp () {
  return (
    <ol>
      <li>Boost is <strong>exactly</strong> like a tip from other stashers: it ranks the item higher based on the amount</li>
      <li>30% of boost funds the weekly curator rewards, 70% supports the platform</li>
      <li>Boosted items can be downvoted to reduce their rank</li>
    </ol>
  )
}
