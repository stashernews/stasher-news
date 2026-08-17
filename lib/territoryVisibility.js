// Turf visibility gate (spec: 2026-08-17-turf-visibility-gate-design.md). A turf
// whose fee is pending (billingStatus PENDING_FEE) is hidden from everyone except
// its owner while its billing PayIn is a CREATE/UNARCHIVE — i.e. the turf has
// never been seen publicly. Renewals (TERRITORY_BILLING) and updates
// (TERRITORY_UPDATE) are EXISTING turfs mid-grace and stay visible. Pure
// predicates only (no Prisma, no lexical) so both the SQL read surfaces and the
// Prisma-side validation can share them.
export const NEVER_SEEN_FEE_PAY_IN_TYPES = ['TERRITORY_CREATE', 'TERRITORY_UNARCHIVE']

/** True when the turf's fee is pending AND it has never been publicly seen. */
export function isNeverSeenPendingFee (sub) {
  return sub?.billingStatus === 'PENDING_FEE' &&
    NEVER_SEEN_FEE_PAY_IN_TYPES.includes(sub.billingPayIn?.payInType)
}

/**
 * Read-surface visibility for a viewer. The owner always sees their own pending
 * turf (they need the page to pay); anon and strangers do not.
 */
export function isHiddenFromViewer (sub, me) {
  if (!isNeverSeenPendingFee(sub)) return false
  return !me || Number(sub.userId) !== Number(me.id)
}
