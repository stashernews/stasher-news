// components/drafts-menu.js
// Server-side drafts: a split button (save draft | list) mounted top-right of
// each create form, plus a list-only instance on the /post type-picker page
// (no Form ancestor -> no formik -> no save half). The list is cross-type;
// opening a draft navigates to the draft's OWN form route on the ROOT /post
// path with ?draft=<id> (see the cross-type contract in the drafts plan).
// Explicit save only — no autosave in v1.
import { useRouter } from 'next/router'
import { useFormikContext } from 'formik'
import SplitButton from 'react-bootstrap/SplitButton'
import Dropdown from 'react-bootstrap/Dropdown'
import Alert from 'react-bootstrap/Alert'
import { useMutation, useQuery } from '@apollo/client/react'
import { MY_DRAFTS, UPSERT_DRAFT, DELETE_DRAFT } from '@/fragments/draft'
import { xmrToPiconeros } from '@/lib/format'
import { DRAFT_MAX_COUNT, DRAFT_MEDIA_CAP_BYTES } from '@/lib/constants'
import { timeSince } from '@/lib/time'
import { useToast } from './toast'
import { useMe } from './me'

// Draft.type -> /post?type=<t>. Always lowercase query values; always root
// /post (never a turf-scoped path — defaultPostType would override the type).
const TYPE_QUERY = { DISCUSSION: 'discussion', LINK: 'link', BOUNTY: 'bounty', POLL: 'poll' }

const MB = 1024 * 1024

export default function DraftsMenu ({ type }) {
  const router = useRouter()
  const toaster = useToast()
  const { me } = useMe()
  const formik = useFormikContext() // undefined on the picker page
  const { data, refetch } = useQuery(MY_DRAFTS, { skip: !me })
  const [upsertDraft] = useMutation(UPSERT_DRAFT)
  const [deleteDraft] = useMutation(DELETE_DRAFT)

  const drafts = data?.myDrafts ?? [] // cross-type: NO per-type filter
  const loadedDraftId = router.query.draft

  const save = async () => {
    if (!formik) return // picker-page instance: list-only, nothing to save
    const v = formik.values
    try {
      // built inside the try: xmrToPiconeros throws on an invalid/empty
      // bounty amount, and that must surface as a toast, not reject silently
      const input = {
        id: loadedDraftId,
        type,
        title: v.title || null,
        text: v.text || null,
        url: v.url || null,
        subName: v.subNames?.[0] ?? null,
        // per-form fields are simply absent in the other forms -> null
        bountyPiconeros: v.amount != null ? String(xmrToPiconeros(v.amount)) : null,
        pollOptions: v.options ?? null,
        pollExpiresAt: v.pollExpiresAt ?? null,
        randPollOptions: v.randPollOptions ?? null,
        // wall display fields hold NUMBERS (the inputs are type="number") —
        // DraftInput declares String, so coerce when present; explicit
        // empty/absent check (not ||) so a numeric 0 behaves predictably
        moneroWallPriceXmr: v.moneroWallEnabled && v.moneroWallPriceXmr != null && v.moneroWallPriceXmr !== '' ? String(v.moneroWallPriceXmr) : null,
        moneroWallThresholdXmr: v.moneroWallEnabled && v.moneroWallThresholdXmr != null && v.moneroWallThresholdXmr !== '' ? String(v.moneroWallThresholdXmr) : null
      }
      await upsertDraft({ variables: { input } })
      toaster.success('draft saved')
      await refetch()
    } catch (err) {
      toaster.danger(err?.message ?? 'failed to save draft')
    }
  }

  // cross-type navigation: the draft's own type, root path, draft id in query.
  // the ?draft param + PostForm's remount key make the target form mount
  // fresh and prefill via usePostFormShared.
  const openDraft = (d) => {
    router.push({ pathname: '/post', query: { type: TYPE_QUERY[d.type], draft: d.id } })
  }

  const remove = async (e, d) => {
    e.stopPropagation()
    await deleteDraft({ variables: { id: d.id } }).catch(() => {})
    await refetch()
    // deleting the draft that's currently open leaves a stale editing
    // session behind — reset it to a clean form
    if (loadedDraftId && String(loadedDraftId) === String(d.id)) {
      router.replace({ query: { ...router.query, draft: undefined } }, undefined, { shallow: true })
    }
  }

  // leave the editing session without publishing: delete + back to a clean form
  const discard = async () => {
    await deleteDraft({ variables: { id: loadedDraftId } }).catch(() => {})
    await refetch()
    router.replace({ query: { ...router.query, draft: undefined } }, undefined, { shallow: true })
  }

  const pinnedBytes = drafts.reduce((acc, d) => acc + BigInt(d.pinnedMediaBytes ?? 0), 0n)
  const showFooter = drafts.length > 0 // meter hidden entirely at 0 drafts (approved)
  const loadedDraft = loadedDraftId ? drafts.find(d => String(d.id) === String(loadedDraftId)) : undefined

  // drafts are a per-user feature: no menu (and no MY_DRAFTS traffic) signed out
  if (!me) return null

  const list = (
    <>
      <Dropdown.Header>your drafts · {drafts.length} / {DRAFT_MAX_COUNT}</Dropdown.Header>
      {drafts.map(d => (
        <Dropdown.Item key={d.id} onClick={() => openDraft(d)}>
          <span className='d-flex justify-content-between gap-2'>
            <span className='text-truncate' style={{ maxWidth: 200 }}>
              <span className='text-muted me-1' style={{ fontSize: '.7em' }}>{d.type.toLowerCase()}</span>
              {d.title || d.text?.slice(0, 40) || `draft ${d.id}`}
            </span>
            <span role='button' tabIndex={0} onClick={e => remove(e, d)}>✕</span>
          </span>
        </Dropdown.Item>
      ))}
      {drafts.length === 0 && <Dropdown.ItemText>no drafts yet — save this one to pick it up on any device.</Dropdown.ItemText>}
      {showFooter && <Dropdown.Divider />}
      {showFooter && (
        <Dropdown.ItemText>
          saved media {(Number(pinnedBytes) / MB).toFixed(1)} / {(Number(DRAFT_MEDIA_CAP_BYTES) / MB).toFixed(1)} MB
          <br /><span className='text-muted' style={{ fontSize: '.8em' }}>auto-deletes after 90d of inactivity</span>
        </Dropdown.ItemText>
      )}
    </>
  )

  if (!formik) {
    // picker page: a plain dropdown with only the list (no formik -> no save half)
    return (
      <Dropdown>
        <Dropdown.Toggle variant='outline-secondary' size='sm'>drafts</Dropdown.Toggle>
        <Dropdown.Menu>{list}</Dropdown.Menu>
      </Dropdown>
    )
  }

  return (
    <div className={loadedDraftId ? 'w-100' : undefined}>
      {loadedDraftId && (
        <Alert variant='warning' className='d-flex align-items-center py-1 px-2 mb-2'>
          <span className='text-muted' style={{ fontSize: '.8rem' }}>
            editing draft{loadedDraft ? ` · saved ${timeSince(new Date(loadedDraft.updatedAt))} ago` : ''}
          </span>
          <a
            role='button' tabIndex={0} className='ms-auto text-muted' style={{ fontSize: '.8rem' }}
            onClick={discard}
          >discard draft
          </a>
        </Alert>
      )}
      <div className='d-flex justify-content-end'>
        <SplitButton
          size='sm'
          variant='outline-secondary'
          title={loadedDraftId ? 'update draft' : 'save draft'}
          onClick={save}
        >
          {list}
        </SplitButton>
      </div>
    </div>
  )
}
