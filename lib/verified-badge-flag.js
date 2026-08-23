// Temporary hard-off for the verified badge pending the award/pay redesign.
// The legacy pipeline (hasWallet resolver + maybeGrantVerifiedBadge) is kept
// intact behind this predicate; flip it to true to restore it, or delete both
// gates when the redesign lands. AGENTS.md notes this state.
export function isVerifiedBadgeEnabled () {
  return false
}
