import { gql } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import { useEffect, useRef, useState } from 'react'
import InputGroup from 'react-bootstrap/InputGroup'
import { Form, Input, SubmitButton } from './form'
import { useAnimation } from './animation'
import { useToast } from './toast'
import { moneroUriAmountPiconeros, piconerosToXmr, xmrToPiconeros } from '@/lib/format'
import MoneroPaymentView from './monero-payment-view'
import { REQUIRED_CONFIRMATIONS } from '@/lib/constants'
import { xmrAmountSchema } from '@/lib/validate'
import usePayInMutation from '@/components/payIn/hooks/use-pay-in-mutation'
import { throwUnlessUserCancel } from '@/wallets/client/errors'
import { DONATE } from '@/fragments/payIn'

const DONATE_POLL_MS = 10_000

const DONATE_FEE_STATUS = gql`
  query DonateFeeStatus($id: Int!) {
    payIn(id: $id) { id feeObserved }
  }
`

// DonateModal — the donate flow's modal body (amount form -> QR + poll -> success),
// mirroring components/posting-fee-modal.js. The DONATE payIn is born PAID
// (piconeros=0n; the FeeObservation carries the real on-chain amount), so the
// payIn mutation resolves immediately and payInState can't signal that the
// donation landed. Instead we render the QR and poll PayIn.feeObserved, which
// flips true once the rewardsWalletObserver records a FeeObservation for this
// payIn. Only then do we toast "donated" and close.
export default function DonateModal ({ onClose }) {
  const animate = useAnimation()
  const toaster = useToast()
  const [donateToRewards] = usePayInMutation(DONATE)
  const [payIn, setPayIn] = useState(null)

  const amountPiconeros = payIn
    ? (moneroUriAmountPiconeros(payIn.moneroUri) ?? 0n)
    : 0n

  const { data } = useQuery(DONATE_FEE_STATUS, {
    variables: { id: Number(payIn?.id) },
    skip: !payIn,
    pollInterval: payIn ? DONATE_POLL_MS : 0
  })
  const observed = data?.payIn?.feeObserved === true

  const confirmedRef = useRef(false)
  useEffect(() => {
    if (!observed || confirmedRef.current) return
    confirmedRef.current = true
    animate()
    toaster.success('donated')
    onClose()
  }, [observed, animate, toaster, onClose])

  if (payIn) {
    return (
      <MoneroPaymentView
        moneroUri={payIn.moneroUri}
        amountPiconeros={amountPiconeros}
        heading='Donate to the rewards pool'
        description={`Scan to send ${piconerosToXmr(amountPiconeros)} to the rewards wallet. Curators earn it back.`}
      >
        <p className='text-muted text-center mt-3'>
          <small>
            Your donation funds curator rewards. Detection takes about one block; final confirmation takes about {REQUIRED_CONFIRMATIONS} blocks.
          </small>
        </p>
      </MoneroPaymentView>
    )
  }

  return (
    <Form
      initial={{
        amount: '0.001'
      }}
      schema={xmrAmountSchema}
      onSubmit={async ({ amount }) => {
        const { data, error, payError } = await donateToRewards({
          variables: {
            piconeros: Number(xmrToPiconeros(String(amount)))
          }
        })
        if (error) throw error
        // donations are pessimistic, so a terminal payment failure comes back in
        // payError — but a user-canceled QR isn't news
        throwUnlessUserCancel(payError)
        setPayIn(data.donateToRewards)
      }}
    >
      <Input
        label='amount'
        name='amount'
        type='number'
        required
        autoFocus
        append={<InputGroup.Text className='text-monospace'>XMR</InputGroup.Text>}
      />
      <div className='d-flex'>
        <SubmitButton variant='success' className='ms-auto mt-1 px-4' value='TIP'>donate</SubmitButton>
      </div>
    </Form>
  )
}
