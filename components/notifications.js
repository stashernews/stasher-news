import { useState, useEffect, useMemo, useCallback } from 'react'
import { gql } from '@apollo/client'
import { useQuery, useApolloClient } from '@apollo/client/react'
import Comment, { CommentSkeleton } from './comment'
import { CardMedia } from './card-media'
import Item, { onItemClick } from './item'
import ItemJob from './item-job'
import { NOTIFICATIONS } from '@/fragments/notifications'
import MoreFooter from './more-footer'
import Invite from './invite'
import { dayMonthYear, timeSince } from '@/lib/time'
import Link from 'next/link'
import Check from '@/svgs/check-double-line.svg'
import HandCoin from '@/svgs/hand-coin-fill.svg'
import UserAdd from '@/svgs/user-add-fill.svg'
import { LOST_BLURBS, FOUND_BLURBS, PAY_IN_ACT_TYPES } from '@/lib/constants'
import FlameIcon from '@/svgs/flame.svg'
import VerifiedIcon from '@/svgs/verified.svg'
import { RootProvider } from './root'
import Alert from 'react-bootstrap/Alert'
import styles from './notifications.module.css'
import { useServiceWorker } from './serviceworker'
import { Checkbox, Form } from './form'
import { useRouter } from 'next/router'
import { useData } from './use-data'
import Text from '@/components/text'
import { numWithUnits, piconerosToMXmr } from '@/lib/format'
import { LongCountdown } from './countdown'
import { nextBillingWithGrace } from '@/lib/territory'
import { commentSubTreeRootId } from '@/lib/item'
import { COPY } from '@/lib/rebrand-copy'
import { questTitle, QUEST_REPLY_REWARDS } from '@/lib/quests'
import LinkToContext from './link-to-context'
import { Badge, Button } from 'react-bootstrap'
import { useToast } from './toast'
import classNames from 'classnames'
import { useMe } from './me'
import { getFailedRetryPayIn, runManualRetry, useRetryPayIn } from './payIn/hooks/use-retry-pay-in'
import { withActBump } from './item-act'
import { isAutoRetryEligiblePayIn } from './payIn/hooks/use-auto-retry-pay-ins'
import { isInvoiceSetupPending, toFailedPayIn } from '@/lib/pay-in'
import { reconcileNotificationItemCounters } from '@/lib/apollo'
import MapIcon from '@/svgs/map.svg'

function Notification ({ n, fresh }) {
  const type = n.__typename

  return (
    <NotificationLayout nid={nid(n)} type={type} {...defaultOnClick(n)} fresh={fresh}>
      {
        (type === 'Earn' && <EarnNotification n={n} />) ||
        (type === 'Revenue' && <RevenueNotification n={n} />) ||
        (type === 'Invitification' && <Invitification n={n} />) ||
        (type === 'Referral' && <Referral n={n} />) ||
        (type === 'Flame' && <Flame n={n} />) ||
        (type === 'NewVerified' && <Verified n={n} />) ||
        (type === 'QuestComplete' && <QuestComplete n={n} />) ||
        (type === 'FlameDay' && <FlameDay n={n} />) ||
        (type === 'Votification' && <Votification n={n} />) ||
        (type === 'BountyPayment' && <BountyPayment n={n} />) ||
        (type === 'Mention' && <Mention n={n} />) ||
        (type === 'ItemMention' && <ItemMention n={n} />) ||
        (type === 'JobChanged' && <JobChanged n={n} />) ||
        (type === 'Reply' && <Reply n={n} />) ||
        (type === 'SubStatus' && <SubStatus n={n} />) ||
        (type === 'FollowActivity' && <FollowActivity n={n} />) ||
        (type === 'TerritoryPost' && <TerritoryPost n={n} />) ||
        (type === 'TerritoryTransfer' && <TerritoryTransfer n={n} />) ||
        (type === 'Reminder' && <Reminder n={n} />) ||
        (type === 'PayInification' && (
          ((n.payIn.payInType === 'WITHDRAWAL' || n.payIn.payInType === 'AUTO_WITHDRAWAL') && <PayInWithdrawal n={n} />) ||
            <PayInFailed n={n} />
        )) ||
        (type === 'ReferralReward' && <ReferralReward n={n} />) ||
        (type === 'Bulletinification' && <Bulletinification n={n} />)
      }
    </NotificationLayout>
  )
}

function NotificationLayout ({ children, type, nid, href, as, fresh }) {
  const router = useRouter()
  if (!href) return <div className={`py-2 ${fresh ? styles.fresh : ''}`}>{children}</div>
  return (
    <LinkToContext
      className={`notif-row py-2 clickToContext ${type === 'Reply' ? styles.reply : ''} ${fresh ? styles.fresh : ''} ${router?.query?.nid === nid ? 'outline-it' : ''}`}
      onClick={async (e) => {
        e.preventDefault()
        nid && await router.replace({
          pathname: router.pathname,
          query: {
            ...router.query,
            nid
          }
        }, router.asPath, { ...router.options, shallow: true })
        router.push(href, as)
      }}
      href={href}
      pad
    >
      {children}
    </LinkToContext>
  )
}

function NoteHeader ({ color, children, big }) {
  return (
    <div className={`${styles.noteHeader} note-head text-${color} ${big ? '' : 'small'} pb-2`}>
      {children}
    </div>
  )
}

// The media preview is hoisted out of the item subtree and rendered as a
// direct child of the notification row: the row — not this wrapper — must be
// its positioning context, because .linkBox ~ * (link-to-context.module.css)
// makes the wrapper position: relative and would capture the pin. Notification
// rows always use the compact square thumbnail (see .notif-row in
// styles/stealth-theme.scss), independent of the compact feed toggle.
// The hoisted CardMedia renders only in the post branch — the exact branch
// Item rendered it in before (jobs and comments never had a preview), and
// CardMedia itself returns null for locked monerowall, hidden-media prefs,
// and items without uploads, leaving no node and no reserved space.
function NoteItem ({ item, ...props }) {
  const router = useRouter()
  return (
    <>
      <div>
        {item.isJob
          ? <ItemJob item={item} {...props} />
          : item.title
            ? <Item item={item} noMedia itemClassName='pt-0' {...props} />
            : (
              <RootProvider root={item.root || item}>
                <Comment item={item} noReply includeParent clickToContext {...props} />
              </RootProvider>)}
      </div>
      {item.title && !item.isJob && (
        <CardMedia item={item} onClick={(e) => onItemClick(e, router, item)} />
      )}
    </>
  )
}

const defaultOnClick = n => {
  const type = n.__typename
  if (type === 'Earn') {
    let href = '/rewards/'
    if (n.minSortTime !== n.sortTime) {
      href += `${dayMonthYear(new Date(n.minSortTime))}/`
    }
    href += dayMonthYear(new Date(n.sortTime))
    return { href }
  }

  const itemLink = item => {
    if (!item) return {}
    if (item.title) {
      return {
        href: {
          pathname: '/items/[id]',
          query: { id: item.id }
        },
        as: `/items/${item.id}`
      }
    } else {
      const rootId = commentSubTreeRootId(item)
      return {
        href: {
          pathname: '/items/[id]',
          query: { id: rootId, commentId: item.id }
        },
        as: `/items/${rootId}`
      }
    }
  }

  if (type === 'Revenue') return { href: `/~${n.subName}` }
  if (type === 'SubStatus') return { href: `/~${n.sub.name}` }
  if (type === 'Invitification') return { href: '/referrals' }
  if (type === 'PayInification') return { href: `/transactions/${n.payIn.id}` }
  if (['Flame', 'NewVerified', 'QuestComplete', 'FlameDay'].includes(type)) return {}
  if (type === 'TerritoryTransfer') return { href: `/~${n.sub.name}` }

  if (!n.item) return {}

  // Votification, Mention, JobChanged, Reply all have item
  return itemLink(n.item)
}

function blurb (n) {
  const type = n.__typename.includes('Flame') ? 'FLAME' : 'VERIFIED'
  const lost = n.days || n.__typename.includes('Lost')
  const blurbs = lost ? (LOST_BLURBS[type] || FOUND_BLURBS[type]) : FOUND_BLURBS[type]
  const index = Number(n.id) % blurbs.length
  return blurbs[index]
}

function Bulletinification ({ n }) {
  if (!n.bulletin) return null
  return (
    <div className='d-flex'>
      {n.bulletin.iconType === 'MAP' ? <div style={{ fontSize: '2rem', alignSelf: 'center' }}><MapIcon className='align-self-center fill-theme-color mx-1' width={64} height={100} /></div> : null}
      <div className='ms-3 p-1'>
        <div className='fw-bold pb-2'>{n.bulletin.title}</div>
        {n.bulletin.html && n.bulletin.lexicalState && <Text html={n.bulletin.html} state={n.bulletin.lexicalState} />}
      </div>
    </div>
  )
}

function Flame ({ n }) {
  const lost = !!n.days
  let body = ''
  if (lost) {
    body = `After ${numWithUnits(n.days, {
      abbreviate: false,
      unitSingular: 'day',
      unitPlural: 'days'
    })}, `
  }
  body += lost ? 'you lost your flame' : "You're on fire!"

  return (
    <div className='d-flex'>
      <div style={{ fontSize: '2rem' }}><FlameIcon style={{ color: '#ff6e6e' }} height={40} width={40} /></div>
      <div className='ms-1 p-1'>
        <span className='fw-bold'>{body}</span>
        <div><small style={{ lineHeight: '140%', display: 'inline-block' }}>{blurb(n)}</small></div>
      </div>
    </div>
  )
}

// Per-day flame copy: the day the flame reached, and what that day paid.
const FLAME_DAY_COPY = {
  1: 'your flame is kindled, +1 reply banked',
  2: 'your flame grows, +1 free post banked',
  3: 'your flame burns brighter, +1 free reply banked',
  4: 'your flame burns golden today, brighter and stronger than ever',
  5: 'your flame grows, +1 free reply banked',
  6: 'your flame grows, +1 free post banked',
  7: 'your flame completes the cycle, turf creation discount banked'
}

function FlameDay ({ n }) {
  // golden arms at cycle day 4 (the shield rung), matching the ladder
  const gold = n.day >= 4
  return (
    <div className='d-flex'>
      <div style={{ fontSize: '2rem' }}><FlameIcon style={{ color: gold ? 'var(--gold, #ffd166)' : '#ff6e6e' }} height={40} width={40} /></div>
      <div className='ms-1 p-1'>
        <span className='fw-bold'>{n.day ? `flame · day ${n.day}` : 'flame advanced'}</span>
        <div><small style={{ lineHeight: '140%', display: 'inline-block' }}>{FLAME_DAY_COPY[n.day] ?? 'you cleared both daily ops'}</small></div>
      </div>
    </div>
  )
}

function QuestComplete ({ n }) {
  const amount = QUEST_REPLY_REWARDS[n.quest] ?? 1
  return (
    <div className='d-flex'>
      <div style={{ fontSize: '2.6rem', lineHeight: '40px', fontWeight: 700, color: '#fada5e', width: 40, textAlign: 'center' }}>!</div>
      <div className='ms-1 p-1'>
        <span className='fw-bold'>quest complete</span>
        <div><small style={{ lineHeight: '140%', display: 'inline-block' }}>{questTitle(n.quest)} · +{amount} {amount === 1 ? 'reply' : 'replies'} banked</small></div>
      </div>
    </div>
  )
}

function Verified ({ n }) {
  return (
    <div className='d-flex'>
      <div style={{ fontSize: '2rem', alignSelf: 'center' }}><VerifiedIcon className='fill-grey' height={40} width={40} /></div>
      <div className='ms-1 p-1'>
        <span className='fw-bold'>{COPY.verifiedTitle}</span>
        <div><small style={{ lineHeight: '140%', display: 'inline-block' }}>{blurb(n)}</small></div>
      </div>
    </div>
  )
}

function EarnNotification ({ n }) {
  const time = n.minSortTime === n.sortTime ? dayMonthYear(new Date(n.minSortTime)) : `${dayMonthYear(new Date(n.minSortTime))} to ${dayMonthYear(new Date(n.sortTime))}`

  return (
    <div className='d-flex'>
      <HandCoin className='align-self-center fill-primary mx-1' width={24} height={24} style={{ flex: '0 0 24px', transform: 'rotateY(180deg)' }} />
      <div className='ms-2'>
        <NoteHeader color='primary' big>
          you stashed {piconerosToMXmr(BigInt(n.earnedPiconeros))} in rewards<small className='text-muted ms-1 fw-normal' suppressHydrationWarning>{time}</small>
        </NoteHeader>
        {n.sources &&
          <div style={{ fontSize: '80%', color: 'var(--theme-grey)' }}>
            {n.sources.posts > 0 && <span>{piconerosToMXmr(BigInt(n.sources.posts))} for top posts</span>}
            {n.sources.comments > 0 && <span>{n.sources.posts > 0 && ' \\ '}{piconerosToMXmr(BigInt(n.sources.comments))} for top comments</span>}
            {n.sources.tipPosts > 0 && <span>{(n.sources.comments > 0 || n.sources.posts > 0) && ' \\ '}{piconerosToMXmr(BigInt(n.sources.tipPosts))} for tipping top posts early</span>}
            {n.sources.tipComments > 0 && <span>{(n.sources.comments > 0 || n.sources.posts > 0 || n.sources.tipPosts > 0) && ' \\ '}{piconerosToMXmr(BigInt(n.sources.tipComments))} for tipping top comments early</span>}
          </div>}
        <div style={{ lineHeight: '140%' }}>
          SN distributes the XMR it earns to top stashers like you weekly. The top stashers make the top posts and comments or tip the top posts and comments early and generously. View the rewards pool and make a donation <Link href='/rewards'>here</Link>.
        </div>
        <small className='text-muted ms-1 pb-1 fw-normal'>click for details</small>
      </div>
    </div>
  )
}

function ReferralReward ({ n }) {
  return (
    <div className='d-flex'>
      <UserAdd className='align-self-center fill-success mx-1' width={24} height={24} style={{ flex: '0 0 24px', transform: 'rotateY(180deg)' }} />
      <div className='ms-2'>
        <NoteHeader color='success' big>
          you stashed {piconerosToMXmr(BigInt(n.earnedPiconeros))} in referral rewards<small className='text-muted ms-1 fw-normal' suppressHydrationWarning>{dayMonthYear(new Date(n.sortTime))}</small>
        </NoteHeader>
        {n.sources &&
          <div style={{ fontSize: '80%', color: 'var(--theme-grey)' }}>
            {n.sources.forever > 0 && <span>{piconerosToMXmr(BigInt(n.sources.forever))} for stashers joining because of you</span>}
            {n.sources.oneDay > 0 && <span>{n.sources.forever > 0 && ' \\ '}{piconerosToMXmr(BigInt(n.sources.oneDay))} for stashers referred to content by you today</span>}
          </div>}
        <div style={{ lineHeight: '140%' }}>
          SN gives referral rewards to stashers like you for referring the top stashers weekly. You refer stashers when they visit your posts, comments, profile, or turf, or if they visit SN through your referral links.
        </div>
      </div>
    </div>
  )
}

function RevenueNotification ({ n }) {
  return (
    <div className='d-flex'>
      <HandCoin className='align-self-center fill-success mx-1' width={24} height={24} style={{ flex: '0 0 24px' }} />
      <div className='ms-2'>
        <NoteHeader color='success' big>
          you stashed {piconerosToMXmr(BigInt(n.earnedPiconeros))} in turf revenue<small className='text-muted ms-1 fw-normal' suppressHydrationWarning>{timeSince(new Date(n.sortTime))}</small>
        </NoteHeader>
        <div style={{ lineHeight: '140%' }}>
          As the founder of turf <Link href={`/~${n.subName}`}>~{n.subName}</Link>, you receive 100% of the posting fees and boosts paid in your turf, including your premium.
        </div>
      </div>
    </div>
  )
}

function SubStatus ({ n }) {
  const dueDate = nextBillingWithGrace(n.sub)
  return (
    <div className={`fw-bold text-${n.sub.status === 'ACTIVE' ? 'success' : 'danger'} `}>
      {n.sub.status === 'ACTIVE'
        ? 'your turf is active again'
        : (n.sub.status === 'GRACE'
            ? <>your turf payment for ~{n.sub.name} is due or your turf will be archived in <LongCountdown date={dueDate} /></>
            : <>your turf ~{n.sub.name} has been archived</>)}
      <small className='text-muted d-block pb-1 fw-normal'>click to visit turf and pay</small>
    </div>
  )
}

function Invitification ({ n }) {
  return (
    <>
      <NoteHeader color='secondary'>
        your invite has been redeemed by
        {' ' + numWithUnits(n.invite.giftedCount ?? 0, {
          abbreviate: false,
          unitSingular: 'stasher',
          unitPlural: 'stashers'
        })}
      </NoteHeader>
      <div className='ms-4 me-2 mt-1'>
        <Invite
          invite={n.invite} active={
          !n.invite.revoked &&
          !n.invite.full
        }
        />
      </div>
    </>
  )
}

function PayInFailed ({ n }) {
  const [disableRetry, setDisableRetry] = useState(false)
  const toaster = useToast()
  const { me } = useMe()
  const client = useApolloClient()
  const { payIn, payInItem: item } = n
  const updatePayIn = useCallback((cache, { data }) => {
    // a wrap-/creation-failed retry returns an invoice-less successor in a transient
    // PENDING_INVOICE_* state. It's a guaranteed failure (queuePayInFailed is already enqueued
    // server-side), so show it as FAILED now
    const retryPayIn = isInvoiceSetupPending(data.retryPayIn)
      ? toFailedPayIn(data.retryPayIn, 'EXECUTION_FAILED')
      : data.retryPayIn
    cache.writeFragment({
      id: `PayInification:${n.id}`,
      fragment: gql`
        fragment _ on PayInification {
          payIn {
            id
            piconeros
            payInType
            payInState
            payInStateChangedAt
            payerPrivates {
              retryCount
              payInFailureReason
            }
          }
        }
      `,
      data: {
        payIn: retryPayIn
      }
    })
  }, [n.id])

  const revertPayIn = useCallback((error, cache, { data }) => {
    const failedRetryPayIn = getFailedRetryPayIn(error, data)
    if (!failedRetryPayIn) return
    cache.writeFragment({
      id: `PayInification:${n.id}`,
      fragment: gql`
        fragment __ on PayInification {
          payIn {
            id
            payInState
            payInStateChangedAt
            payerPrivates {
              payInFailureReason
            }
          }
        }
      `,
      data: {
        payIn: failedRetryPayIn
      }
    })
  }, [n.id])

  // acts re-bump the item at click time (like the modal/bolt) rather than via an optimisticResponse,
  // so no act optimisticResponse here; bounty bumps bountyPaidTo optimistically.
  const isAct = PAY_IN_ACT_TYPES.includes(payIn.payInType)
  const actResult = isAct
    ? {
        id: item.id,
        piconeros: payIn.piconeros,
        act: payIn.payInType === 'TIP' ? 'TIP' : payIn.payInType === 'DOWNVOTE' ? 'DONT_LIKE_THIS' : 'BOOST',
        path: item.path
      }
    : null
  const optimisticResponse = payIn.payInType === 'BOUNTY_PAYMENT'
    ? { payInType: 'BOUNTY_PAYMENT', piconeros: payIn.piconeros, payerPrivates: { result: { id: item.id, path: item.path, __typename: 'Item' } } }
    : undefined
  // only retry once (protocolLimit = 1) with wallets since we want to show the QR code on failures that end up in the notifications
  const mutationOptions = {
    onRetry: updatePayIn,
    cachePhases: {
      onMutationResult: updatePayIn,
      onPaid: updatePayIn,
      onPayError: revertPayIn
    },
    protocolLimit: 1,
    ...(optimisticResponse ? { optimisticResponse } : {})
  }
  const retryPayIn = useRetryPayIn(payIn.id, payIn.payInType, mutationOptions)

  const [actionString, colorClass, retry] = useMemo(() => {
    const retry = retryPayIn
    let actionString = ''
    const itemType = item.title ? 'post' : 'comment'
    if (payIn.payInType === 'ITEM_CREATE') {
      actionString = `${itemType} create `
    } else if (payIn.payInType === 'BOUNTY_PAYMENT') {
      actionString = `bounty payment on ${itemType} `
    } else {
      if (payIn.payInType === 'TIP') {
        actionString = 'tip'
      } else if (payIn.payInType === 'DOWNVOTE') {
        actionString = 'downvote'
      } else if (payIn.payInType === 'BOOST') {
        actionString = 'boost'
      }
      actionString = `${actionString} on ${itemType} `
    }
    let colorClass = 'info'
    switch (payIn.payInState) {
      case 'PAID':
        actionString += 'paid'
        colorClass = 'success'
        break
      default:
        if (isAutoRetryEligiblePayIn(payIn) || payIn.payInState !== 'FAILED') {
          actionString += 'pending'
        } else {
          actionString += 'failed'
          colorClass = 'warning'
        }
    }
    return [actionString, colorClass, retry]
  }, [payIn, item, retryPayIn])

  return (
    <div>
      <NoteHeader color={colorClass}>
        {actionString}
        <span className='ms-1 text-muted fw-light'> {piconerosToMXmr(BigInt(payIn.piconeros))}</span>
        <span className={['FAILED'].includes(payIn.payInState) && !isAutoRetryEligiblePayIn(payIn) ? 'visible' : 'invisible'}>
          <Button
            size='sm' variant={classNames('outline-warning ms-2 border-1 rounded py-0', disableRetry && 'pulse')}
            style={{ '--bs-btn-hover-color': '#fff', '--bs-btn-active-color': '#fff' }}
            disabled={disableRetry}
            onClick={() => {
              if (disableRetry) return
              // for acts, bump the item at click time (same root bump the modal/bolt use)
              return runManualRetry(
                isAct ? () => withActBump(client.cache, actResult, me, retry) : retry,
                { setDisable: setDisableRetry, toaster })
            }}
          >
            retry
          </Button>
          <span className='text-muted ms-2 fw-normal' suppressHydrationWarning>{timeSince(new Date(payIn.payInStateChangedAt))}</span>
        </span>
      </NoteHeader>
      <NoteItem item={item} setDisableRetry={setDisableRetry} disableRetry={disableRetry} updatePayIn={updatePayIn} />
    </div>
  )
}

function PayInWithdrawal ({ n }) {
  const amount = n.earnedPiconeros
  let actionString = 'withdrawn from your account'

  if (n.payIn.payInType === 'AUTO_WITHDRAWAL') {
    actionString = 'sent to your attached wallet'
  }

  return (
    <div className='fw-bold text-info'>
      <Check className='fill-info me-1' />
      {piconerosToMXmr(BigInt(amount))}
      {actionString}
      <small className='text-muted ms-1 fw-normal' suppressHydrationWarning>{timeSince(new Date(n.sortTime))}</small>
      {n.payIn.payInType === 'AUTO_WITHDRAWAL' && <Badge className={styles.badge} bg={null}>autowithdraw</Badge>}
    </div>
  )
}

function Referral ({ n }) {
  const { me } = useMe()
  let referralSource = 'of you'
  switch (n.source?.__typename) {
    case 'Item':
      referralSource = (Number(me?.id) === Number(n.source.user?.id) ? 'of your' : 'you shared this') + ' ' + (n.source.title ? 'post' : 'comment')
      break
    case 'Sub':
      referralSource = (Number(me?.id) === Number(n.source.userId) ? 'of your' : 'you shared the') + ' ~' + n.source.name + ' turf'
      break
    case 'User':
      referralSource = (me?.name === n.source.name ? 'of your profile' : `you shared ${n.source.name}'s profile`)
      break
  }
  return (
    <>
      <small className='fw-bold text-success'>
        <UserAdd className='fill-success me-1' height={21} width={21} style={{ transform: 'rotateY(180deg)' }} />someone joined SN because {referralSource}
        <small className='text-muted ms-1 fw-normal' suppressHydrationWarning>{timeSince(new Date(n.sortTime))}</small>
      </small>
      {n.source?.__typename === 'Item' && <NoteItem itemClassName='pt-2' item={n.source} />}
    </>
  )
}

function stackedText (item, total) {
  if (total === undefined) total = Number(item.piconeros)
  return piconerosToMXmr(BigInt(total))
}

function Votification ({ n }) {
  return (
    <>
      <NoteHeader color='success'>
        <span className='d-inline-flex'>
          <span>
            your {n.item.title ? 'post' : 'reply'} stashed {stackedText(n.item)}
          </span>
        </span>
      </NoteHeader>
      <NoteItem item={n.item} />
    </>
  )
}

function BountyPayment ({ n }) {
  return (
    <div className='d-flex'>
      <HandCoin className='align-self-center fill-success mx-1' width={24} height={24} style={{ flex: '0 0 24px' }} />
      <div className='ms-2'>
        <NoteHeader color='success'>
          you received a {piconerosToMXmr(BigInt(n.earnedPiconeros))} bounty payment
        </NoteHeader>
        <NoteItem item={n.item} />
      </div>
    </div>
  )
}

function Mention ({ n }) {
  return (
    <>
      <NoteHeader color='info'>
        you were mentioned in
      </NoteHeader>
      <NoteItem item={n.item} />
    </>
  )
}

function ItemMention ({ n }) {
  return (
    <>
      <NoteHeader color='info'>
        your item was mentioned in
      </NoteHeader>
      <NoteItem item={n.item} />
    </>
  )
}

function JobChanged ({ n }) {
  return (
    <>
      <NoteHeader color={n.item.status === 'ACTIVE' ? 'success' : 'boost'}>
        {n.item.status === 'ACTIVE'
          ? 'your job is active again'
          : (n.item.status === 'NOSATS'
              ? 'your job promotion ran out of funds'
              : 'your job has been stopped')}
      </NoteHeader>
      <ItemJob item={n.item} />
    </>
  )
}

function Reply ({ n }) {
  return <NoteItem item={n.item} />
}

function FollowActivity ({ n }) {
  return (
    <>
      <NoteHeader color='info'>
        a stasher you subscribe to {n.item.parentId ? 'commented' : 'posted'}
      </NoteHeader>
      <NoteItem item={n.item} />
    </>
  )
}

function TerritoryPost ({ n }) {
  return (
    <>
      <NoteHeader color='info'>
        new post in ~{n.item.subs?.length === 1 ? n.item.subs[0].name : 'a turf you follow'}
      </NoteHeader>
      <NoteItem item={n.item} />
    </>
  )
}

function TerritoryTransfer ({ n }) {
  return (
    <div className='fw-bold text-info '>
      ~{n.sub.name} was transferred to you
      <small className='text-muted ms-1 fw-normal' suppressHydrationWarning>{timeSince(new Date(n.sortTime))}</small>
    </div>
  )
}

function Reminder ({ n }) {
  return (
    <>
      <NoteHeader color='info'>
        you requested this reminder
      </NoteHeader>
      <NoteItem item={n.item} />
    </>
  )
}

export function NotificationAlert () {
  const [showAlert, setShowAlert] = useState(false)
  const [hasSubscription, setHasSubscription] = useState(false)
  const [error, setError] = useState(null)
  const [supported, setSupported] = useState(false)
  const sw = useServiceWorker()

  useEffect(() => {
    const isSupported = sw.support.serviceWorker && sw.support.pushManager && sw.support.notification && sw.pushConfigured
    if (isSupported) {
      const isDefaultPermission = sw.permission.notification === 'default'
      setShowAlert(isDefaultPermission && !!sw.registration && !window.localStorage.getItem('hideNotifyPrompt'))
      sw.registration?.pushManager?.getSubscription()?.then(subscription => setHasSubscription(!!subscription))?.catch(console.error)
      setSupported(!!sw.registration && sw.pushConfigured)
    }
  }, [sw])

  const close = () => {
    window.localStorage.setItem('hideNotifyPrompt', 'yep')
    setShowAlert(false)
  }

  return (
    error
      ? (
        <Alert variant='danger' dismissible onClose={() => setError(null)}>
          <span>{navigator?.brave && error.name === 'AbortError'
            ? 'Push registration failed. Enable "Use Google services for push messaging" in Brave\'s privacy settings and try again.'
            : error.toString()}
          </span>
        </Alert>
        )
      : showAlert
        ? (
          <Alert variant='info' dismissible onClose={close}>
            <span className='align-middle'>Enable push notifications?</span>
            <button
              className={`${styles.alertBtn} mx-1`}
              onClick={async () => {
                await sw.requestNotificationPermission()
                  .then(close)
                  .catch(setError)
              }}
            >Yes
            </button>
            <button className={styles.alertBtn} onClick={close}>No</button>
          </Alert>
          )
        : (
          <Form className={`d-flex justify-content-end ${supported ? 'visible' : 'invisible'}`} initial={{ pushNotify: hasSubscription }}>
            <Checkbox
              name='pushNotify' label={<span className='text-muted'>push notifications</span>}
              groupClassName={`${styles.subFormGroup} mb-1 me-sm-3 me-0`}
              inline checked={hasSubscription} handleChange={async () => {
                await sw.togglePushSubscription().catch(setError)
              }}
            />
          </Form>
          )
  )
}

const nid = n => n.__typename + n.id + n.sortTime

export default function Notifications ({ ssrData }) {
  const { data, fetchMore } = useQuery(NOTIFICATIONS)
  const client = useApolloClient()
  const router = useRouter()
  const dat = useData(data, ssrData)

  // a failed pay-in optimistically bumped an item's counters; its PayInification notification
  // carries the server's truth. reconcile here (not in an ApolloLink) because the feed arrives
  // via SSR + cache-first, so no client-link request ever fires. covers the SSR first page and
  // fetchMore pages since dat is the merged, displayed list.
  useEffect(() => {
    reconcileNotificationItemCounters(client.cache, dat?.notifications?.notifications)
  }, [client, dat])

  const { notifications, lastChecked, cursor } = useMemo(() => {
    if (!dat?.notifications) return {}

    // make sure we're using the oldest lastChecked we've seen
    const retDat = { ...dat.notifications }
    if (ssrData?.notifications?.lastChecked < retDat.lastChecked) {
      retDat.lastChecked = ssrData.notifications.lastChecked
    }
    return retDat
  }, [dat])

  useEffect(() => {
    if (lastChecked && !router?.query?.checkedAt) {
      router.replace({
        pathname: router.pathname,
        query: {
          ...router.query,
          nodata: true, // make sure nodata is set so we don't fetch on back/forward
          checkedAt: lastChecked
        }
      }, router.asPath, { ...router.options, shallow: true })
    }
  }, [router?.query?.checkedAt, lastChecked])

  if (!dat) return <CommentsFlatSkeleton />

  return (
    <>
      {notifications.map(n =>
        <Notification
          n={n} key={nid(n)}
          fresh={new Date(n.sortTime) > new Date(router?.query?.checkedAt ?? lastChecked)}
        />)}
      <MoreFooter cursor={cursor} count={notifications?.length} fetchMore={fetchMore} Skeleton={CommentsFlatSkeleton} noMoreText='NO MORE' />
    </>
  )
}

function CommentsFlatSkeleton () {
  const comments = new Array(21).fill(null)

  return (
    <div>
      {comments.map((_, i) => (
        <CommentSkeleton key={i} skeletonChildren={0} />
      ))}
    </div>
  )
}
