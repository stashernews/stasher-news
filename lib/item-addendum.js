// lib/item-addendum.js
// Post-window item addenda (2026-10-04 spec): pure helpers shared by the
// resolver, resolvers' field computations, and the client hooks. No DB, no
// React. The full-edit gate in api/resolvers/item.js stays authoritative for
// first-stage edits — these helpers mirror its timing and exceptions without
// relaxing it.
import { ITEM_EDIT_SECONDS, MAX_ITEM_ADDENDUM_LENGTH } from '@/lib/constants'
import { datePivot } from '@/lib/time'
import { canonicalizeItemText } from '@/lib/url'
import { splitMoneroWallText } from '@/lib/monero-wall'
import { GqlInputError } from '@/lib/error'

// The full-edit deadline: the paid ITEM_CREATE's settlement stamp when present
// (payment-settlement anchor, exactly as updateItem computes it), else creation.
export function itemEditDeadline (item) {
  return datePivot(new Date(item.payIn?.payInStateChangedAt ?? item.createdAt), {
    seconds: ITEM_EDIT_SECONDS
  })
}

// Which editor an author gets for this item right now:
//   NONE     — no editing surface (foreign/missing/deleted, or a bio viewed
//              without the myBio exception)
//   FULL     — the existing typed forms, inside the 600s window or under an
//              existing forever-edit exception (bio, job, admin item)
//   ADDENDUM — original locked; only the 200-char addendum is writable
export function getItemEditMode (item, {
  meId, myBio = false, adminEdit = false, now = Date.now()
} = {}) {
  if (!item || item.deletedAt || meId == null) return 'NONE'
  // client cache rows carry user { id } (fragments), server rows carry both —
  // accept either shape
  const author = Number(item.user?.id ?? item.userId) === Number(meId)
  if (!author && !adminEdit) return 'NONE'
  // isJob(item) upstream asserts non-null subNames; legacy rows (pre-migration,
  // synthetic) can carry NULL — never crash the mode computation on them
  const job = item.subNames?.includes('jobs') ?? false
  if (item.payIn?.payInState !== 'PAID' ||
      now < itemEditDeadline(item).getTime() ||
      adminEdit || myBio || job) return 'FULL'
  if (item.bio) return 'NONE'
  return 'ADDENDUM'
}

// Validate + normalize a submitted addendum. Returns canonical Markdown or ''
// for an intentional clear. Length is checked on the submitted source AND the
// canonicalized text (signed imgproxy URLs decode longer→shorter, but a
// crafted surrogate must not slip past either measurement).
export function normalizeAddendumText (value) {
  if (typeof value !== 'string') throw new GqlInputError('addendum text is required')
  const source = value.trim()
  const text = canonicalizeItemText(source).trim()
  if (source.length > MAX_ITEM_ADDENDUM_LENGTH || text.length > MAX_ITEM_ADDENDUM_LENGTH) {
    throw new GqlInputError(`addendum must be at most ${MAX_ITEM_ADDENDUM_LENGTH} characters`)
  }
  if (splitMoneroWallText(text).hasMarker) {
    throw new GqlInputError('an addendum cannot add a monerowall')
  }
  return text
}

export const ADDENDUM_CONFLICT_MESSAGE = 'This addendum changed in another session. Your draft is preserved; reload the latest version before saving.'

// Finding #3: an author attempted to publish a full edit after the 10-minute
// window ended. The mounted form and its typed values stay visible, but every
// submission path must refuse — this message is shown in the expiry notice.
export const EXPIRED_FULL_EDIT_MESSAGE = 'The full-edit window ended. This edit can no longer be saved, and your text is preserved so you can copy anything you still need.'

// The expiry latch's reset decision for the client hook, kept pure so the
// re-anchor regression is unit-testable: when the deadline moves (an unpaid
// creation's fee settles late, re-anchoring payInStateChangedAt), the latch
// must follow the NEW deadline — a latch stuck true never re-arms its timer
// and the UI would offer the FULL editor past the new window, surfacing only
// a generic server rejection.
export function nextExpiryLatch (editThreshold, now = Date.now()) {
  return now >= +editThreshold
}

// The addendum form's submit flow, kept here (react-free) so the conflict
// contract is unit-testable. On E_ADDENDUM_CONFLICT it THROWS a tagged error —
// the caller's Form catch then shows the message and skips its success-path
// localStorage cleanup, so the local draft genuinely survives for the
// reload-and-retry flow. Any other error propagates untouched.
export async function submitItemAddendum ({ updateItemAddendum, id, text, expectedRevision }) {
  try {
    await updateItemAddendum({ variables: { id, text: text ?? '', expectedRevision } })
  } catch (e) {
    if (e?.graphQLErrors?.some(g => g.extensions?.code === 'E_ADDENDUM_CONFLICT')) {
      const err = new Error(ADDENDUM_CONFLICT_MESSAGE)
      err.name = 'E_ADDENDUM_CONFLICT'
      throw err
    }
    throw e
  }
}
