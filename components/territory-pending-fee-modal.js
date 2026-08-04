import { useRouter } from 'next/router'
import { useEffect } from 'react'
import { gql } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import { moneroUriAmountPiconeros, piconerosToXmr } from '@/lib/format'
import MoneroPaymentView from './monero-payment-view'

const SUB_BILLING_STATUS_POLL_MS = 10_000

const SUB_BILLING_STATUS = gql`
  query SubBillingStatus($name: String!) {
    sub(name: $name) {
      name
      billingStatus
    }
  }
`

export default function TerritoryPendingFeeModal ({ moneroUri, subName }) {
  const router = useRouter()
  const feePiconeros = moneroUriAmountPiconeros(moneroUri) ?? 0n

  const { data } = useQuery(SUB_BILLING_STATUS, {
    variables: { name: String(subName) },
    pollInterval: SUB_BILLING_STATUS_POLL_MS
  })

  const billingStatus = data?.sub?.billingStatus

  const paid = billingStatus === 'PAID'

  // navigate to the live territory once the fee is observed
  useEffect(() => {
    if (paid) {
      router.push(`/~${subName}`)
    }
  }, [paid, subName, router])

  if (paid) return null

  return (
    <MoneroPaymentView
      moneroUri={moneroUri}
      amountPiconeros={feePiconeros}
      heading='Pay the territory fee'
      description={`Scan to send ${piconerosToXmr(feePiconeros)} to the platform rewards wallet. Your territory goes live once the fee is detected on-chain.`}
    >
      <p className='text-muted text-center mt-3'>
        <small>
          Your territory stays hidden until the fee lands — detection takes about one block.
        </small>
      </p>
    </MoneroPaymentView>
  )
}
