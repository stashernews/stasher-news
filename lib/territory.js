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

// A cadence switch is a paid action only when it moves to a longer/once plan
// (monthly→yearly, *→once). Downgrades (yearly→monthly) are free and simply
// take effect when the paid year ends. Lives in lib/ (pure) because the client
// territory form uses the same rule to tell a billing fee from an upload fee.
export function needsCadenceFee (oldSub, newBillingType) {
  if (!oldSub || oldSub.billingType === newBillingType) return false
  return newBillingType === 'YEARLY' || newBillingType === 'ONCE'
}
