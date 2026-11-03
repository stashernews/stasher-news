import { POOL_RUNWAY_LABELS } from '@/lib/rewardsPoolHealth'
import { piconerosToXmr } from '@/lib/format'

const STATUS_CLASS = {
  GROWING: 'text-success',
  STABLE: 'text-warning',
  DRAINING: 'text-danger'
}

export function poolStatusClass (status) {
  return STATUS_CLASS[status] ?? 'text-muted'
}

export function runwayLabel (runway) {
  return POOL_RUNWAY_LABELS[runway] ?? null
}

// The curator budget the footer and /rewards headline: the live projection
// when the dynamic budget is active, otherwise the fallback cap ("up to").
export function curatorBudgetHeadline (budget) {
  const projected = budget?.mode === 'ACTIVE' ? budget?.projectedPiconeros : null
  if (projected != null) return { amount: piconerosToXmr(BigInt(projected), 3), upTo: false }
  if (budget?.fallbackBudgetPiconeros == null) return null
  return { amount: piconerosToXmr(BigInt(budget.fallbackBudgetPiconeros), 3), upTo: true }
}
