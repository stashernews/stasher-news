import Link from 'next/link'
import { useRouter } from 'next/router'
import { useCallback, useEffect, useState } from 'react'
import Badge from 'react-bootstrap/Badge'
import Button from 'react-bootstrap/Button'
import Dropdown from 'react-bootstrap/Dropdown'
import Countdown from './countdown'
import { isPendingFeeItem, shouldShowItemPaidAt } from '@/lib/pay-in'
import PostingFeeModal from './posting-fee-modal'
import BountyFundingView from './bounty-funding-view'
import { AwardBountyDropdownItem } from './bounty-actions'
import { numWithUnits, piconerosToXmr } from '@/lib/format'
import { bountyPiconerosOf, bountyStatusWord } from '@/lib/bounty'
import { newComments, commentsViewedAt } from '@/lib/new-comments'
import { timeSince } from '@/lib/time'
import { DeleteDropdownItem } from './delete'
import styles from './item.module.css'
import { useMe } from './me'
import DontLikeThisDropdownItem from './dont-link-this'
import BookmarkDropdownItem from './bookmark'
import SubscribeDropdownItem from './subscribe'
import { CopyLinkDropdownItem, CrosspostDropdownItem } from './share'
import Badges from './badge'
import { DEFAULT_POSTS_PICONEROS_FILTER, DEFAULT_COMMENTS_PICONEROS_FILTER } from '@/lib/constants'
import ActionDropdown from './action-dropdown'
import MuteDropdownItem from './mute'
import { DropdownItemUpVote } from './upvote'
import { useRoot } from './root'
import { MuteSubDropdownItem, PinSubDropdownItem } from './territory-header'
import UserPopover from './user-popover'
import useQrPayIn from './payIn/hooks/use-qr-pay-in'
import { useToast } from './toast'
import { useShowModal } from './modal'
import classNames from 'classnames'
import SubPopover from './sub-popover'
import useCanEdit from './use-can-edit'
import { getFailedRetryPayIn, runManualRetry, useRetryPayIn } from './payIn/hooks/use-retry-pay-in'
import { isAutoRetryEligiblePayIn } from './payIn/hooks/use-auto-retry-pay-ins'
import { gql } from '@apollo/client'
import { useBranding } from './territory-branding'
import LinkExternal from '@/svgs/link-external.svg'

function itemTitle (item) {
  let title = ''
  title += numWithUnits(item.upvotes, {
    abbreviate: false,
    unitSingular: 'tipper',
    unitPlural: 'tippers'
  })
  if (Number(item.piconeros) - Number(item.credits)) {
    title += ` \\ ${piconerosToXmr(BigInt(Number(item.piconeros) - Number(item.credits)))} stashed`
  }
  if (item.credits) {
    title += ` \\ ${numWithUnits(item.credits, { abbreviate: false, unitSingular: 'credit', unitPlural: 'credits' })} stashed`
  }
  if (item.boost) {
    title += ` \\ ${numWithUnits(item.boost, { abbreviate: false, unitSingular: 'boost', unitPlural: 'boost' })}`
  }
  if (item.cost) {
    title += ` \\ ${numWithUnits(item.cost, { abbreviate: false, unitSingular: 'cost', unitPlural: 'cost' })}`
  }
  if (item.downPiconeros) {
    title += ` \\ ${piconerosToXmr(BigInt(item.downPiconeros))} downvoted`
  }
  if (item.mePiconeros || item.meDontLikePiconeros || item.meAnonPiconeros) {
    const satSources = []
    if (item.meAnonPiconeros || (Number(item.mePiconeros || 0) - Number(item.meCredits || 0)) > 0) {
      satSources.push(`${piconerosToXmr(BigInt(Number(item.mePiconeros || 0) + Number(item.meAnonPiconeros || 0) - Number(item.meCredits || 0)))}`)
    }
    if (item.meCredits) {
      satSources.push(`${numWithUnits(item.meCredits, { abbreviate: false, unitSingular: 'credit', unitPlural: 'credits' })}`)
    }
    if (item.meDontLikePiconeros) {
      satSources.push(`${piconerosToXmr(BigInt(item.meDontLikePiconeros))}`)
    }
    if (satSources.length) {
      title += ` (${satSources.join(' & ')} from me)`
    }
  }
  return title
}

export default function ItemInfo ({
  item, full, commentsText = 'comments',
  commentTextSingular = 'comment', className, embellishUser, extraInfo, edit, toggleEdit, editText,
  onQuoteReply, extraBadges, nested, pinnable, showActionDropdown = true, showUser = true,
  setDisableRetry, disableRetry, updatePayIn
}) {
  const { me } = useMe()
  const branding = useBranding()
  const router = useRouter()
  const showModal = useShowModal()
  const [hasNewComments, setHasNewComments] = useState(false)
  const root = useRoot()
  // XXX sub controls pinning options for territory founders
  // so we only expose it if there's only one sub
  const subs = item?.subs || root?.subs
  const sub = subs?.length === 1 ? subs[0] : undefined
  const [canEdit, setCanEdit, editThreshold] = useCanEdit(item)

  useEffect(() => {
    if (!full) {
      setHasNewComments(newComments(item))
    }
  }, [item])

  // territory founders can pin any post in their territory
  // and OPs can pin any root reply in their post
  const isPost = !item.parentId
  const mySub = (me && sub && Number(me.id) === sub.userId)
  const myPost = (me && root && Number(me.id) === Number(root.user.id))
  const rootReply = item.path.split('.').length === 2
  const canPin = (isPost && mySub) || (myPost && rootReply)
  const isPinnedPost = isPost && item.position && (pinnable || !item.subNames)
  const isPinnedSubReply = !isPost && item.position && !item.subNames
  const meSats = (me ? item.mePiconeros : item.meAnonPiconeros) || 0
  const satsFilter = me
    ? (isPost ? me.privates?.postsPiconerosFilter : me.privates?.commentsPiconerosFilter)
    : (isPost ? DEFAULT_POSTS_PICONEROS_FILTER : DEFAULT_COMMENTS_PICONEROS_FILTER)
  const isDesperado = !item.mine && item.downPiconeros > 0 &&
    satsFilter != null && (item.netInvestment ?? 0) < satsFilter

  return (
    <div className={className || `${styles.other}`}>
      {!isPinnedPost && !(isPinnedSubReply && !full) &&
        <>
          <span title={itemTitle(item)}>
            {piconerosToXmr(BigInt(Number(item.piconeros) + Number(item.boost) + Number(item.cost) * 1000))}
          </span>
          {Number(item.downPiconeros) > 0 &&
            <span className='text-danger'> -{piconerosToXmr(BigInt(item.downPiconeros))}</span>}
          <span> \ </span>
        </>}
      <Link
        href={`/items/${item.id}`} onClick={(e) => {
          const viewedAt = commentsViewedAt(item.id)
          if (viewedAt) {
            e.preventDefault()
            router.push(
              `/items/${item.id}?commentsViewedAt=${viewedAt}`,
              `/items/${item.id}`)
          }
        }} title={`${piconerosToXmr(BigInt(Number(item.commentPiconeros) + Number(item.commentCost) * 1000 + Number(item.commentBoost)))} (${item.commentPiconeros} stashed \\ ${item.commentCost} cost \\ ${item.commentBoost} boost)`} className='text-reset position-relative'
      >
        {numWithUnits(item.ncomments, {
          abbreviate: false,
          unitPlural: commentsText,
          unitSingular: commentTextSingular
        })}
        {hasNewComments &&
          <span className={styles.notification}>
            <span className='invisible'>{' '}</span>
          </span>}
      </Link>
      <span> \ </span>
      <span>
        {showUser &&
          <Link href={`/${item.user.name}`}>
            <UserPopover name={item.user.name}>@{item.user.name}</UserPopover>
            <Badges badgeClassName='fill-grey' spacingClassName='ms-xs' height={12} width={12} user={item.user} bot={item.apiKey} />
            {embellishUser}
          </Link>}
        <span> </span>
        <Link href={`/items/${item.id}`} title={item.payIn?.payInStateChangedAt || item.createdAt} className='text-reset' suppressHydrationWarning>
          {timeSince(new Date(item.payIn?.payInStateChangedAt || item.createdAt))}
        </Link>
        {item.prior &&
          <>
            <span> \ </span>
            <Link href={`/items/${item.prior}`} className='text-reset'>
              yesterday
            </Link>
          </>}
      </span>
      {/* XXX: ideally we would use the proxy middleware to handle external subnames, but it would break local dev: https://github.com/vercel/next.js/issues/44482 */}
      {item.subNames?.map(subName => {
        const isExternal = branding && (subName !== branding.subName)
        const href = branding ? (isExternal ? `${process.env.NEXT_PUBLIC_URL}/~${subName}` : '/') : `/~${subName}`

        return (
          <SubPopover key={subName} sub={subName}>
            <Link href={href} target={isExternal ? '_blank' : undefined} rel={isExternal ? 'noopener noreferrer' : undefined}>
              {' '}<Badge className={styles.newComment} bg={null}>{subName} {isExternal && <LinkExternal width={10} height={10} />}</Badge>
            </Link>
          </SubPopover>
        )
      })}
      {item.feeStatus === 'PENDING_FEE' &&
        <span>
          {' '}<Badge className={styles.newComment} bg={null}>pending payment</Badge>
        </span>}
      {Number(item.bountyPiconeros) > 0 &&
        <span>
          {' '}<Badge className={styles.newComment} bg={null}>bounty {piconerosToXmr(bountyPiconerosOf(item.bountyPiconeros))} · {bountyStatusWord(item.bountyStatus)}</Badge>
        </span>}
      {sub?.nsfw &&
        <Badge className={styles.newComment} bg={null}>nsfw</Badge>}
      {item.freebie && !item.position &&
        <Link href='/new/freebies'>
          {' '}<Badge className={styles.newComment} bg={null}>freebie</Badge>
        </Link>}
      {isDesperado &&
        <span
          role='button' onClick={() => showModal((onClose) => <ItemDetails item={item} me={me} />)}
        >
          {' '}<Badge className={styles.newComment} bg={null}>-{piconerosToXmr(BigInt(item.downPiconeros || 0))}</Badge>
        </span>}
      {extraBadges}
      {full && isPendingFeeItem(item) && item.payIn?.moneroUri &&
        <>{' '}
          <Button
            size='sm' variant='outline-danger'
            onClick={() => showModal((onClose) => <PostingFeeModal moneroUri={item.payIn.moneroUri} itemId={item.id} />)}
          >
            pay the posting fee
          </Button>
        </>}
      {full && item.mine && Number(item.bountyPiconeros) > 0 && ['UNFUNDED', 'PENDING_FUNDING'].includes(item.bountyStatus) &&
        <>{' '}
          <Button
            size='sm' variant='outline-success'
            onClick={() => showModal((onClose) => <BountyFundingView postId={item.id} amountPiconeros={bountyPiconerosOf(item.bountyPiconeros)} onClose={onClose} />)}
          >
            fund bounty
          </Button>
        </>}
      {
        showActionDropdown &&
          <>
            <EditInfo
              item={item} edit={edit} canEdit={canEdit}
              setCanEdit={setCanEdit} toggleEdit={toggleEdit} editText={editText} editThreshold={editThreshold}
            />
            {item.payIn && <PayInInfo item={item} updatePayIn={updatePayIn} disableRetry={disableRetry} setDisableRetry={setDisableRetry} />}
            <ActionDropdown>
              <CopyLinkDropdownItem item={item} />
              <InfoDropdownItem item={item} />
              {(item.parentId || item.text) && onQuoteReply &&
                <Dropdown.Item onClick={onQuoteReply}>quote reply</Dropdown.Item>}
              {me && <BookmarkDropdownItem item={item} />}
              {me && <SubscribeDropdownItem item={item} />}
              {item.otsHash &&
                <Link href={`/items/${item.id}/ots`} className='text-reset dropdown-item'>
                  opentimestamp
                </Link>}
              {item?.noteId && (
                <Dropdown.Item onClick={() => window.open(`https://njump.me/${item.noteId}`, '_blank', 'noopener,noreferrer,nofollow')}>
                  nostr note
                </Dropdown.Item>
              )}
              {item && item.mine && !item.noteId && !item.isJob && !item.parentId &&
                <CrosspostDropdownItem item={item} />}
              {me && root?.bountyStatus === 'FUNDED' && Number(root.user?.id) === Number(me.id) && item.parentId && !item.mine && !item.deletedAt &&
                <AwardBountyDropdownItem item={item} root={root} />}
              {me && !item.mine && !item.deletedAt &&
            (item.meDontLikePiconeros > meSats
              ? <DropdownItemUpVote item={item} />
              : <DontLikeThisDropdownItem item={item} />)}
              {item.mine && item.payIn?.id &&
                <>
                  <hr className='dropdown-divider' />
                  <Link href={`/transactions/${item.payIn?.id}`} className='text-reset dropdown-item'>
                    view payment
                  </Link>
                </>}
              {me && !nested && !item.mine && sub && Number(me.id) !== Number(sub.userId) &&
                <>
                  <hr className='dropdown-divider' />
                  <MuteSubDropdownItem item={item} sub={sub} />
                </>}
              {canPin &&
                <>
                  <hr className='dropdown-divider' />
                  <PinSubDropdownItem item={item} />
                </>}
              {item.mine && !item.position && !item.deletedAt && !item.bio &&
                <>
                  <hr className='dropdown-divider' />
                  <DeleteDropdownItem itemId={item.id} type={item.title ? 'post' : 'comment'} />
                </>}
              {me && !item.mine &&
                <>
                  <hr className='dropdown-divider' />
                  <MuteDropdownItem user={item.user} />
                </>}
            </ActionDropdown>
          </>
      }
      {extraInfo}
    </div>
  )
}

function ItemDetails ({ item, me }) {
  return (
    <div className={styles.details}>
      <div className={styles.detailsSection}>item</div>
      <div className={styles.detailsLabel}>id</div>
      <div className={styles.detailsValue}>{item.id}</div>
      <div className={styles.detailsLabel}>created at</div>
      <div className={styles.detailsValue}>{item.createdAt}</div>
      {shouldShowItemPaidAt(item) &&
        <>
          <div className={styles.detailsLabel}>paid at</div>
          <div className={styles.detailsValue}>{item.payIn?.payInStateChangedAt}</div>
        </>}
      <div className={styles.detailsSection}>this item</div>
      <div className={styles.detailsLabel}>tippers</div>
      <div className={styles.detailsValue}>{item.upvotes}</div>
      <div className={styles.detailsLabel}>cost</div>
      <div className={styles.detailsValue}>{piconerosToXmr(BigInt(item.cost) * 1000n)}</div>
      <div className={styles.detailsLabel}>boost</div>
      <div className={styles.detailsValue}>{piconerosToXmr(BigInt(item.boost))}</div>
      <div className={styles.detailsLabel}>stashed</div>
      <div className={styles.detailsValue}>{piconerosToXmr(BigInt(Number(item.piconeros) - Number(item.credits)))} / {item.credits} credits</div>
      <div className={styles.detailsLabel}>downvotes</div>
      <div className={styles.detailsValue}>{piconerosToXmr(BigInt(item.downPiconeros || 0))}</div>
      <div className={styles.detailsLabel}>invested</div>
      <div className={styles.detailsValue}>{piconerosToXmr(BigInt(Number(item.piconeros) + Number(item.boost) + Number(item.cost)))}</div>
      <div className={styles.detailsSection}>comments</div>
      <div className={styles.detailsLabel}>cost</div>
      <div className={styles.detailsValue}>{piconerosToXmr(BigInt(item.commentCost) * 1000n)}</div>
      <div className={styles.detailsLabel}>boost</div>
      <div className={styles.detailsValue}>{piconerosToXmr(BigInt(item.commentBoost))}</div>
      <div className={styles.detailsLabel}>stashed</div>
      <div className={styles.detailsValue}>{piconerosToXmr(BigInt(Number(item.commentPiconeros) - Number(item.commentCredits)))} / {item.commentCredits} credits</div>
      <div className={styles.detailsLabel}>downvotes</div>
      <div className={styles.detailsValue}>{piconerosToXmr(BigInt(item.commentDownPiconeros || 0))}</div>
      <div className={styles.detailsLabel}>invested</div>
      <div className={styles.detailsValue}>{piconerosToXmr(BigInt(Number(item.commentPiconeros) + Number(item.commentBoost) + Number(item.commentCost)))}</div>
      {me && (
        <>
          <div className={styles.detailsSection}>from me</div>
          <div className={styles.detailsLabel}>tipped</div>
          <div className={styles.detailsValue}>{piconerosToXmr(BigInt(Number(item.mePiconeros) - Number(item.meCredits)))} / {item.meCredits} credits</div>
          <div className={styles.detailsLabel}>downvoted</div>
          <div className={styles.detailsValue}>{piconerosToXmr(BigInt(item.meDontLikePiconeros || 0))}</div>
        </>
      )}
    </div>
  )
}

export function InfoDropdownItem ({ item }) {
  const { me } = useMe()
  const showModal = useShowModal()

  return (
    <Dropdown.Item onClick={() => showModal(() => <ItemDetails item={item} me={me} />)}>
      details
    </Dropdown.Item>
  )
}

export function PayInInfo ({ item, updatePayIn, disableRetry, setDisableRetry }) {
  const { me } = useMe()
  const toaster = useToast()

  const revertPayIn = useCallback((error, cache, { data }) => {
    const failedRetryPayIn = getFailedRetryPayIn(error, data)
    if (!failedRetryPayIn) return
    cache.writeFragment({
      // PayIn normalizes by ['id', 'isSend'] (lib/apollo.js), so a raw `PayIn:${id}` writes to an orphan entity
      id: cache.identify({ __typename: 'PayIn', id: failedRetryPayIn.id, isSend: true }),
      fragment: gql`
        fragment PayInInfoRevert on PayIn {
          payInState
          payInStateChangedAt
          payerPrivates {
            payInFailureReason
          }
        }
      `,
      data: failedRetryPayIn
    })
  }, [])

  const retryPayIn = useRetryPayIn(item.payIn.id, item.payIn.payInType, {
    onRetry: updatePayIn,
    cachePhases: {
      onMutationResult: updatePayIn,
      onPaid: updatePayIn,
      onPayError: revertPayIn
    },
    protocolLimit: 1
  })
  const waitForQrPayIn = useQrPayIn()
  const [disableInfoRetry, setDisableInfoRetry] = useState(disableRetry)
  if (item.deletedAt) return null

  const disableDualRetry = disableRetry || disableInfoRetry
  function setDisableDualRetry (value) {
    setDisableInfoRetry(value)
    setDisableRetry?.(value)
  }

  let Component
  let onClick
  const canManagePayIn = me &&
    item.mine &&
    item.payIn?.payInType === 'ITEM_CREATE' &&
    item.payIn?.payInState !== 'PAID' &&
    item.payIn?.payerPrivates

  if (canManagePayIn) {
    // are we automatically retrying?
    if (isAutoRetryEligiblePayIn(item.payIn)) {
      Component = () => <span className={classNames('text-info')}>pending</span>
    } else if (item.payIn.payInState === 'FAILED') {
      Component = () => <span className={classNames('text-warning', disableDualRetry ? 'pulse' : 'pointer')}>retry payment</span>
      onClick = () => {
        if (disableDualRetry) return
        return runManualRetry(retryPayIn, { setDisable: setDisableDualRetry, toaster })
      }
    } else {
      Component = () => (
        <span
          className='text-info pointer'
        >pending
        </span>
      )
      onClick = () => waitForQrPayIn(item.payIn, null, { cancelOnClose: false }).catch(console.error)
    }
  } else {
    return null
  }

  return (
    <>
      <span> \ </span>
      <span
        className='text-reset fw-bold'
        onClick={onClick}
      >
        <Component />
      </span>
    </>
  )
}

function EditInfo ({ item, edit, canEdit, setCanEdit, toggleEdit, editText, editThreshold }) {
  const router = useRouter()

  if (canEdit) {
    return (
      <>
        <span> \ </span>
        <span
          className='text-reset pointer fw-bold font-monospace'
          onClick={() => toggleEdit ? toggleEdit() : router.push(`/items/${item.id}/edit`)}
        >
          <span>{editText || 'edit'} </span>
          {(!item.payIn?.payInState || item.payIn?.payInState === 'PAID')
            ? <Countdown
                date={editThreshold}
                onComplete={() => { setCanEdit(false) }}
              />
            : <span>10:00</span>}
        </span>
      </>
    )
  }

  if (edit && !canEdit) {
    // if we're still editing after timer ran out
    return (
      <>
        <span> \ </span>
        <span
          className='text-reset pointer fw-bold font-monospace'
          onClick={() => toggleEdit ? toggleEdit() : router.push(`/items/${item.id}`)}
        >
          <span>cancel </span>
          <span>00:00</span>
        </span>
      </>
    )
  }

  return null
}
