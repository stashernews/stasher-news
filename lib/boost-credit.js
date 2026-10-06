// Pure eligibility predicate for redeeming a flame boost credit on an item
// (spec 2026-10-05-quest-rebalance-boost-credit, task 4). Dependency-free so
// the server resolver and the client both agree without importing the heavy
// item resolver barrel.

/**
 * May `userId` spend a boost credit on `item`? Server rows carry `item.userId`,
 * client payload carries `item.user.id` — both accepted. The item must be a
 * top-level non-bio post that is alive (never deleted), ACTIVE, and either has
 * its posting fee paid or never required one. A missing/null feeStatus fails
 * closed.
 *
 * @param {Object} item - item row or client item payload
 * @param {number|bigint|string|null} userId - the redeemer
 * @returns {boolean}
 */
export function canUseBoostCreditOnItem (item, userId) {
  const ownerId = item?.userId ?? item?.user?.id
  return userId != null && ownerId != null && String(ownerId) === String(userId) &&
    item.parentId === null && item.bio === false && item.deletedAt == null &&
    item.status === 'ACTIVE' && ['FEE_PAID', 'FEE_NOT_REQUIRED'].includes(item.feeStatus)
}
