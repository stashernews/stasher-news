import { useState, useEffect, useMemo, useCallback } from 'react'
import { datePivot } from '@/lib/time'
import { useMe } from '@/components/me'
import { ITEM_EDIT_SECONDS } from '@/lib/constants'
import { getItemEditMode, nextExpiryLatch } from '@/lib/item-addendum'

// Which editor an author gets for this item, computed live on the client from
// the same rules the server enforces (lib/item-addendum.js):
//   NONE     — no editing surface
//   FULL     — the existing typed forms inside the 600s window
//   ADDENDUM — original locked; only the 200-char addendum is writable
// The server's `editMode` field (when the fragment carried it) is authoritative;
// this local computation lets the UI transition the moment the window ends,
// including while an editor is open (countdown onComplete → setCanEdit(false)).
//
// Tuple compatibility: [canEdit, setCanEdit, editThreshold, editMode] — the
// first element is now `mode !== 'NONE'`; the second only retracts/forces the
// affordance and can never grant a mode the rules don't allow.
// The client passes myBio/adminEdit as false: bio and admin editing keep their
// dedicated legacy flows (the bio profile button; the server is still the
// authority for every save).

// The expiry latch's reset decision, kept pure so the re-anchor regression is
// unit-testable: when the deadline moves (an unpaid creation's fee settles
// late, re-anchoring payInStateChangedAt), the latch must follow the NEW
// deadline — a latch stuck true would never re-arm its timer and the UI would
// offer the FULL editor past the new window with only a generic server error.
export default function useCanEdit (item) {
  const editThreshold = datePivot(new Date(item.payIn?.payInStateChangedAt ?? item.createdAt), { seconds: ITEM_EDIT_SECONDS })
  // stable primitive for effect deps: a fresh Date identity every render would
  // re-run the timer/listener effects on every render
  const editThresholdMs = +editThreshold
  const { me } = useMe()

  // paid, timed items flip to ADDENDUM when the clock crosses the deadline —
  // including a suspended tab (visibility/focus recheck on wake)
  const [expired, setExpired] = useState(() => nextExpiryLatch(editThreshold))
  // re-anchor: a deadline that moves (late settlement) resets the latch so the
  // new window arms its own timer/listeners below
  useEffect(() => {
    setExpired(nextExpiryLatch(editThreshold))
  }, [editThreshold])
  useEffect(() => {
    if (expired) return undefined
    const timer = setTimeout(() => setExpired(true), Math.max(0, editThresholdMs - Date.now()))
    const recheck = () => {
      if (Date.now() >= editThresholdMs) setExpired(true)
    }
    window.addEventListener('focus', recheck)
    document.addEventListener('visibilitychange', recheck)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('focus', recheck)
      document.removeEventListener('visibilitychange', recheck)
    }
  }, [expired, editThresholdMs])

  // `expired` is a recompute trigger for the memo (getItemEditMode reads the
  // wall clock); identity churn of `item` recomputes on cache updates, which
  // keeps account switches and fee-state changes honest
  const editMode = useMemo(
    () => getItemEditMode(item, { meId: me?.id, myBio: false, adminEdit: false }),
    [me?.id, item, expired]
  )

  const [override, setOverride] = useState(undefined)
  // legacy contract: setCanEdit(false) came from Countdown onComplete and from
  // editors closing; treat it as "the window ended, recompute into post-window
  // mode" so the affordance transitions to ADDENDUM instead of disappearing
  const setCanEdit = useCallback(value => {
    if (value === false) {
      setExpired(true)
      setOverride(undefined)
    } else if (value === true) {
      setOverride('force')
    } else {
      setOverride(undefined)
    }
  }, [])

  const canEdit = override === 'force' ? true : override === 'deny' ? false : editMode !== 'NONE'

  return [canEdit, setCanEdit, editThreshold, editMode]
}
