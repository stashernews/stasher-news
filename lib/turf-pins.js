// Browser-safe turf pin helpers: pure functions over the Item fields the
// GraphQL schema exposes (subs, turfPins, position, parentId, bio, deletedAt).
// No server imports — this module runs in the client bundle.

// Name comparison must be case-insensitive because turf names are CITEXT on
// the server but arrive as plain strings in GraphQL payloads.
const sameName = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase()

// This post's pin position in one turf, or null when unpinned there.
export function turfPinPosition (item, subName) {
  if (!item || subName == null) return null
  const pin = (item.turfPins ?? []).find(pin => sameName(pin.subName, subName))
  return pin ? pin.position : null
}

// The viewer's owned turf memberships this post actually belongs to, sorted
// by turf name, each with its independent pin state. These are the only
// turfs a pin action may target: membership is persisted state, not a guess
// from the current route or the post's first turf.
export function ownedPinTurfs (item, me) {
  if (!item || !me || item.parentId || item.bio || item.deletedAt) return []
  return (item.subs ?? [])
    .filter(sub => sub.userId != null && Number(sub.userId) === Number(me.id))
    .map(sub => ({
      name: sub.name,
      userId: sub.userId,
      pinned: turfPinPosition(item, sub.name) != null
    }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
}

// Any pin in any representation: the legacy global/reply position (or the
// raw-row pinId behind it), or any turf pin. Drives delete-menu visibility
// and thread-level default behavior — never feed promotion.
export function hasAnyPin (item) {
  if (!item) return false
  if (item.pinId || item.position) return true
  return (item.turfPins ?? []).length > 0
}
