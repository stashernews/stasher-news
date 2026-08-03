import { piconerosToXmr, toBigInt } from '@/lib/format'

// The custodial-token / bolt11 money break-down was removed with the Lightning surface;
// a Monero payIn's cost is its single mcost amount, displayed as XMR via piconeros.
export function PayInMoney ({ payIn }) {
  if (!payIn.mcost || (!payIn.payerPrivates && payIn.payInState !== 'PAID')) {
    return <>N/A</>
  }

  return <>{piconerosToXmr(toBigInt(payIn.mcost))}</>
}
