import JobForm from './job-form'
import { useSiteSettings } from './site-settings'
import Button from 'react-bootstrap/Button'
import { useMe } from './me'
import { useRouter } from 'next/router'
import { DiscussionForm } from './discussion-form'
import { LinkForm } from './link-form'
import { PollForm } from './poll-form'
import { BountyForm } from './bounty-form'
import { SubMultiSelect } from './sub-select'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFormikContext } from 'formik'
import { useQuery } from '@apollo/client/react'
import { ACTIVE_SUBS } from '@/fragments/subs'
import FeeButton, { FeeButtonProvider, postCommentBaseLineItems, postCommentUseRemoteLineItems } from './fee-button'
import Delete from './delete'
import CancelButton from './cancel-button'
import { subNames, subsPostPrefix, postFormType, defaultPostType } from '@/lib/subs'
import PostTypeSwitcher, { POST_TYPES, turfAllowsType } from './post-type-switcher'
import { PostCarryContext } from './use-post-form-shared'

const POST_TYPE_FORMS = {
  link: LinkForm,
  discussion: DiscussionForm,
  poll: PollForm,
  bounty: BountyForm
}

export function PostForm ({ type, subs, children }) {
  const { me } = useMe()
  const siteSettings = useSiteSettings()
  const router = useRouter()

  const formType = postFormType(type, subs) ?? fallbackPostType(subs)

  // The fee estimate must follow the form's SELECTED turfs, not the page's
  // turf scope: a draft prefill (or an edit) sets the selection without a
  // route change, so the page-derived lines quote a phantom posting fee for
  // an author posting to a turf they own (the server's owner-free path
  // charges nothing — see postCommentBaseLineItems' postOwnerFree branch).
  // The selection is reported from inside the Formik tree; names resolve to
  // sub objects through ACTIVE_SUBS, which the turf selector already polls.
  const [selectedSubNames, setSelectedSubNames] = useState(null)
  const { data: activeSubsData } = useQuery(ACTIVE_SUBS)
  const estimateSubs = useMemo(() => {
    if (selectedSubNames == null) return subs
    const byName = new Map((activeSubsData?.activeSubs ?? []).map(s => [s.name, s]))
    return selectedSubNames.map(name => byName.get(name)).filter(Boolean)
  }, [selectedSubNames, activeSubsData, subs])

  const draftId = router.query.draft

  // Type switching keeps what the author typed: the live form's values are
  // reported into valuesRef, and a switch hands title/text (and url, for the
  // types that have one) to the next form through PostCarryContext. The url
  // is remembered across a detour through a url-less type.
  const valuesRef = useRef(null)
  const urlRef = useRef(undefined)
  const [carry, setCarry] = useState(null)

  const switchType = useCallback((next) => {
    const values = valuesRef.current
    if (values) {
      if (values.url !== undefined) urlRef.current = values.url
      const carried = { title: values.title ?? '', text: values.text ?? '' }
      if (TYPES_WITH_URL.includes(next)) carried.url = urlRef.current ?? ''
      // no server draft open -> the forms autosave to localStorage, and the
      // next form's Inputs restore from their own keys on mount (overwriting
      // initial values), so move the carried fields to the next type's keys
      if (!draftId) moveLocalFields(formType, next, carried)
      setCarry({ type: next, draftId: next === 'job' ? undefined : draftId, values: carried })
    }

    // jobs live only in ~jobs; any other type stays in the current turf when
    // it takes that type, else leaves for the unscoped /post
    if (next === 'job') {
      router.push('/~jobs/post?type=job')
      return
    }
    const prefix = turfAllowsType(next, subs) ? subsPostPrefix(subs) : ''
    const query = new URLSearchParams({ type: next })
    if (draftId) query.set('draft', draftId)
    router.push(`${prefix}/post?${query}`, undefined, { shallow: true })
  }, [formType, draftId, subs, router])

  const FormType = formType === 'job' ? JobForm : POST_TYPE_FORMS[formType]
  const carried = carry?.type === formType && carry?.draftId === draftId ? carry.values : null

  return (
    <FeeButtonProvider
      baseLineItems={postCommentBaseLineItems({ me, subs: estimateSubs, siteSettings })}
      useRemoteLineItems={postCommentUseRemoteLineItems({ subs: estimateSubs })}
    >
      <PostTypeSwitcher value={formType} subs={subs} onSelect={switchType} />
      <PostCarryContext.Provider value={carried}>
        {/* remount when the type or the loaded draft changes: Formik's
            one-shot initialValues would silently ignore a newly opened draft */}
        <FormType key={`${formType}:${draftId ?? ''}`} subs={subs}>
          {children}
          <SelectedSubNamesReporter onChange={setSelectedSubNames} />
          <FormValuesReporter valuesRef={valuesRef} />
        </FormType>
      </PostCarryContext.Provider>
    </FeeButtonProvider>
  )
}

const TYPES_WITH_URL = ['link', 'job']
const CARRIED_FIELDS = ['title', 'text', 'url']

// The type /post opens on when the URL names none: discussion where the turf
// takes it, else the first type it does take.
function fallbackPostType (subs) {
  if (turfAllowsType('discussion', subs)) return 'discussion'
  return POST_TYPES.map(t => t.type).find(t => turfAllowsType(t, subs)) ?? 'discussion'
}

// localStorage keys are `${type}-${field}` (components/form.js Input)
function moveLocalFields (from, to, values) {
  try {
    for (const field of CARRIED_FIELDS) {
      window.localStorage.removeItem(`${from}-${field}`)
      const value = values[field]
      if (value) window.localStorage.setItem(`${to}-${field}`, value)
      else window.localStorage.removeItem(`${to}-${field}`)
    }
  } catch {}
}

// Keeps PostForm's valuesRef pointing at the live form's values.
function FormValuesReporter ({ valuesRef }) {
  const formik = useFormikContext()
  valuesRef.current = formik?.values ?? null
  useEffect(() => () => { valuesRef.current = null }, [valuesRef])
  return null
}

// Lifts the form's selected turf names up to PostForm (see estimateSubs above).
// Forms without a multi-turf field (jobs) never report and keep the
// page-derived estimate. Rendered inside FormType so useFormikContext resolves.
function SelectedSubNamesReporter ({ onChange }) {
  const formik = useFormikContext()
  const selected = formik?.values?.subNames

  useEffect(() => {
    if (!Array.isArray(selected)) return
    onChange(prev => {
      const next = selected.filter(Boolean)
      return prev != null && prev.length === next.length && prev.every(name => next.includes(name))
        ? prev
        : next
    })
  }, [selected, onChange])

  return null
}

export default function Post ({ subs }) {
  const router = useRouter()
  const type = defaultPostType(subs) ?? postFormType(router.query.type, subs) ?? fallbackPostType(subs)

  // Turf repost (2026-09-24): posts are created in one turf; more turfs are
  // added with the paid repost action. The bounties feed is type-based
  // (`bounty IS NOT NULL`), so the old bounties auto-append is unnecessary.
  const selectedSubs = subNames(subs)

  return (
    <>
      <PostForm type={type} subs={subs}>
        <SubMultiSelect
          subs={selectedSubs}
          placeholder='pick turfs'
          filterSubs={s => s.postTypes?.includes(type.toUpperCase())}
          className='d-flex'
          size='medium'
          label='turf'
          single
        />
      </PostForm>
    </>
  )
}

export function ItemButtonBar ({
  itemId, canDelete = true, disable,
  className, children, onDelete, onCancel, hasCancel = true,
  createText = 'post', editText = 'save', deleteText = 'delete'
}) {
  const router = useRouter()

  return (
    <div className={`mt-3 ${className}`}>
      <div className='d-flex justify-content-between'>
        {itemId && canDelete &&
          <Delete
            itemId={itemId}
            onDelete={onDelete || (() => router.push(`/items/${itemId}`))}
          >
            <Button variant='grey-medium'>{deleteText}</Button>
          </Delete>}
        {children}
        <div className='d-flex align-items-center ms-auto'>
          {hasCancel && <CancelButton onClick={onCancel} />}
          <FeeButton
            text={itemId ? editText : createText}
            variant='secondary'
            disabled={disable}
          />
        </div>
      </div>
    </div>
  )
}
