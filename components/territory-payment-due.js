import { Alert, Button } from 'react-bootstrap'
import { useMe } from './me'
import FeeButton, { FeeButtonProvider } from './fee-button'
import { TERRITORY_BILLING_OPTIONS } from '@/lib/constants'
import { Form } from './form'
import { timeSince } from '@/lib/time'
import { LongCountdown } from './countdown'
import { useCallback, useState } from 'react'
import { useApolloClient } from '@apollo/client/react'
import { nextBillingWithGrace } from '@/lib/territory'
import usePayInMutation from '@/components/payIn/hooks/use-pay-in-mutation'
import { throwUnlessUserCancel } from '@/wallets/client/errors'
import { SUB_PAY } from '@/fragments/payIn'
import { useShowModal } from './modal'
import TerritoryPendingFeeModal from './territory-pending-fee-modal'

export default function TerritoryPaymentDue ({ sub }) {
  const { me } = useMe()
  const client = useApolloClient()
  const [paySub] = usePayInMutation(SUB_PAY)

  const onSubmit = useCallback(async ({ ...variables }) => {
    const { error, payError } = await paySub({
      variables
    })

    if (error) throw error
    // territory billing is pessimistic, so a terminal payment failure comes back in payError —
    // but a user-canceled QR isn't news
    throwUnlessUserCancel(payError)
  }, [client, paySub])

  if (!sub || sub.userId !== Number(me?.id)) return null

  // a freshly-created or renewed territory whose fee hasn't been observed yet is
  // ACTIVE + PENDING_FEE — show a re-pay button so the founder can pay even from
  // the live territory page
  if (sub.billingStatus === 'PENDING_FEE') {
    return <PendingFeeRepay sub={sub} />
  }

  if (sub.status === 'ACTIVE') return null

  const dueDate = nextBillingWithGrace(sub)
  if (!dueDate) return null

  return (
    <Alert key='danger' variant='danger'>
      {sub.status === 'STOPPED'
        ? (
          <>
            <Alert.Heading>
              Your ~{sub.name} territory has been archived!
            </Alert.Heading>
            <div>
              Make a payment to reactivate it.
            </div>
          </>)
        : (
          <>
            <Alert.Heading>
              Your ~{sub.name} territory payment is due!
            </Alert.Heading>
            <div>
              Your territory will be archived in <LongCountdown date={dueDate} />otherwise.
            </div>
          </>
          )}

      <FeeButtonProvider baseLineItems={{ territory: TERRITORY_BILLING_OPTIONS('one')[sub.billingType.toLowerCase()] }}>
        <Form
          initial={{
            name: sub.name
          }}
          onSubmit={onSubmit}
        >
          <div className='d-flex justify-content-end'>
            <FeeButton
              text='pay'
              variant='success'
            />
          </div>
        </Form>
      </FeeButtonProvider>
    </Alert>
  )
}

function PendingFeeRepay ({ sub }) {
  const showModal = useShowModal()
  const [paySub] = usePayInMutation(SUB_PAY)
  const [submitting, setSubmitting] = useState(false)

  const onPay = useCallback(async () => {
    setSubmitting(true)
    try {
      const { data, error, payError } = await paySub({ variables: { name: sub.name } })
      if (error) throw error
      if (payError) return
      const response = data?.paySub
      if (response?.moneroUri) {
        showModal(onClose => (
          <TerritoryPendingFeeModal moneroUri={response.moneroUri} subName={sub.name} onClose={onClose} />
        ))
      }
    } catch (e) {
      console.error('failed to pay territory fee', e)
    } finally {
      setSubmitting(false)
    }
  }, [paySub, sub.name, showModal])

  return (
    <Alert key='warning' variant='warning'>
      <Alert.Heading>Your ~{sub.name} territory fee is pending payment.</Alert.Heading>
      <div>The territory is live once the Monero fee is detected on-chain.</div>
      <div className='d-flex justify-content-end mt-2'>
        <Button variant='success' disabled={submitting} onClick={onPay}>
          {submitting ? 'generating…' : 'pay territory fee'}
        </Button>
      </div>
    </Alert>
  )
}

export function TerritoryBillingLine ({ sub }) {
  const { me } = useMe()
  if (!sub || sub.userId !== Number(me?.id)) return null

  const dueDate = sub.billPaidUntil && new Date(sub.billPaidUntil)
  const pastDue = dueDate && dueDate < new Date()

  return (
    <div className='text-muted'>
      <span>billing {sub.billingAutoRenew ? 'automatically renews' : 'due'} </span>
      <span className='fw-bold' suppressHydrationWarning>{pastDue ? 'past due' : dueDate ? timeSince(dueDate) : 'never again'}</span>
    </div>
  )
}
