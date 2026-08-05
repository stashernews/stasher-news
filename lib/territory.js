import { TERRITORY_GRACE_DAYS } from './constants'
import { datePivot } from './time'

export function nextBilling (relativeTo, billingType) {
  if (!relativeTo || billingType === 'ONCE') return null

  const pivot = billingType === 'MONTHLY'
    ? { months: 1 }
    : { years: 1 }

  return datePivot(new Date(relativeTo), pivot)
}

export function nextBillingWithGrace (sub) {
  if (!sub) return null
  return datePivot(new Date(sub.billPaidUntil), { days: TERRITORY_GRACE_DAYS })
}
