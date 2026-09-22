import JobForm from './job-form'
import Link from 'next/link'
import Button from 'react-bootstrap/Button'
import Alert from 'react-bootstrap/Alert'
import AccordianItem from './accordian-item'
import { useMe } from './me'
import { useRouter } from 'next/router'
import { DiscussionForm } from './discussion-form'
import { LinkForm } from './link-form'
import { PollForm } from './poll-form'
import { BountyForm } from './bounty-form'
import { SubMultiSelect } from './sub-select'
import { useCallback, useState } from 'react'
import FeeButton, { FeeButtonProvider, postCommentBaseLineItems, postCommentUseRemoteLineItems } from './fee-button'
import DraftsMenu from './drafts-menu'
import Delete from './delete'
import CancelButton from './cancel-button'
import { subNames, subsPostPrefix, subsAllSupport, postFormType, defaultPostType } from '@/lib/subs'

const POST_TYPE_FORMS = {
  link: LinkForm,
  discussion: DiscussionForm,
  poll: PollForm,
  bounty: BountyForm
}

export function PostForm ({ type, subs, children }) {
  const { me } = useMe()
  const router = useRouter()
  const [errorMessage, setErrorMessage] = useState()

  const prefix = subsPostPrefix(subs)
  const formType = postFormType(type, subs)

  const checkSession = useCallback((e) => {
    if (!me) {
      e.preventDefault()
      setErrorMessage('you must be logged in')
    }
  }, [me, setErrorMessage])

  if (!formType) {
    let postButtons = []
    let morePostButtons = []

    if (subs.length) {
      if (subsAllSupport(subs, 'LINK')) {
        postButtons.push(
          <Link key='LINK' href={prefix + '/post?type=link'}>
            <Button variant='secondary'>link</Button>
          </Link>
        )
      }

      if (subsAllSupport(subs, 'DISCUSSION')) {
        postButtons.push(
          <Link key='DISCUSSION' href={prefix + '/post?type=discussion'}>
            <Button variant='secondary'>discussion</Button>
          </Link>
        )
      }

      if (subsAllSupport(subs, 'POLL')) {
        const array = postButtons.length < 2 ? postButtons : morePostButtons
        array.push(
          <Link key='POLL' href={prefix + '/post?type=poll'}>
            <Button variant={postButtons.length < 2 ? 'secondary' : 'info'}>poll</Button>
          </Link>
        )
      }

      if (subsAllSupport(subs, 'BOUNTY')) {
        const array = postButtons.length < 2 ? postButtons : morePostButtons
        array.push(
          <Link key='BOUNTY' href={prefix + '/post?type=bounty'}>
            <Button onClick={checkSession} variant={postButtons.length < 2 ? 'secondary' : 'info'}>bounty</Button>
          </Link>
        )
      }
    } else {
      postButtons = [
        <Link key='LINK' href={prefix + '/post?type=link'}>
          <Button variant='secondary'>link</Button>
        </Link>,
        <Link key='DISCUSSION' href={prefix + '/post?type=discussion'}>
          <Button variant='secondary'>discussion</Button>
        </Link>
      ]
      morePostButtons = [
        <Link key='POLL' href={prefix + '/post?type=poll'}>
          <Button variant='info'>poll</Button>
        </Link>,
        <Link key='BOUNTY' href={prefix + '/post?type=bounty'}>
          <Button onClick={checkSession} variant='info'>bounty</Button>
        </Link>
      ]
    }

    postButtons = postButtons.reduce((acc, cur) => {
      if (acc.length) acc.push(<span key='OR-post-buttons' className='mx-3 fw-bold text-muted'>or</span>)
      acc.push(cur)
      return acc
    }, [])

    morePostButtons = morePostButtons.reduce((acc, cur) => {
      if (acc.length) acc.push(<span key='OR-more-post-buttons' className='mx-3 fw-bold text-muted'>or</span>)
      acc.push(cur)
      return acc
    }, [])

    return (
      <div className='position-relative d-flex flex-column align-items-start'>
        {errorMessage &&
          <Alert className='position-absolute' style={{ top: '-6rem' }} variant='danger' onClose={() => setErrorMessage(undefined)} dismissible>
            {errorMessage}
          </Alert>}
        {subs.length > 0 && (
          <SubMultiSelect
            placeholder='pick turfs'
            className='d-flex'
            noForm
            size='medium'
            single
            subs={subNames(subs)}
          />
        )}
        {/* list-only drafts menu: no Form ancestor -> no formik -> no save half */}
        <div className='align-self-end mb-3'>
          <DraftsMenu />
        </div>
        <div>
          {postButtons}
        </div>
        <div className='d-flex mt-4'>
          <AccordianItem
            headerColor='#6c757d'
            header={<div className='fw-bold text-muted'>more types</div>}
            body={
              <div className='align-items-center'>
                {morePostButtons}
                <div className='mt-3 d-flex justify-content-center'>
                  <Link href='/~jobs/post?type=job'>
                    <Button onClick={checkSession} variant='info'>job</Button>
                  </Link>
                </div>
              </div>
              }
          />
        </div>
      </div>
    )
  }

  const FormType = formType === 'job' ? JobForm : POST_TYPE_FORMS[formType]

  const draftId = router.query.draft

  return (
    <FeeButtonProvider
      baseLineItems={postCommentBaseLineItems({ me, subs })}
      useRemoteLineItems={postCommentUseRemoteLineItems({ subs })}
    >
      {/* remount when the loaded draft changes: cross-type clicks already
          remount (POST_TYPE_FORMS swaps the component); SAME-type clicks need
          this key or Formik's one-shot initialValues silently ignore the
          newly opened draft */}
      <FormType key={`${formType}:${draftId ?? ''}`} subs={subs}>{children}</FormType>
    </FeeButtonProvider>
  )
}

export default function Post ({ subs }) {
  const router = useRouter()
  let type = router.query.type

  const singleType = defaultPostType(subs)
  if (singleType) type = singleType

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
