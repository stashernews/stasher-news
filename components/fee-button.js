import { useEffect, useContext, createContext, useState, useCallback, useMemo } from 'react'
import Table from 'react-bootstrap/Table'
import ActionTooltip from './action-tooltip'
import Info from './info'
import styles from './fee-button.module.css'
import { gql } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import { ANON_COMMENT_FEE_MULTIPLIER, ANON_POST_FEE_MULTIPLIER, DEFAULT_POSTING_FEE_PICONEROS, FAST_POLL_INTERVAL_MS, ITEM_SPAM_FEE_ESCALATION_NUMERATOR, ITEM_SPAM_FEE_ESCALATION_DENOMINATOR, SSR } from '@/lib/constants'
import { piconerosToXmr } from '@/lib/format'
import { useMe } from './me'
import AnonIcon from '@/svgs/spy-fill.svg'
import { useShowModal } from './modal'
import Link from 'next/link'
import { SubmitButton } from './form'

const FeeButtonContext = createContext()

export function postCommentBaseLineItems ({ comment = false, bio = false, me, subs = [] }) {
  // anon multiplier is context-dependent: comments x ANON_COMMENT_FEE_MULTIPLIER (3),
  // posts/bios x ANON_POST_FEE_MULTIPLIER (10).
  const anonMultiplier = comment ? ANON_COMMENT_FEE_MULTIPLIER : ANON_POST_FEE_MULTIPLIER
  const anonCharge = me
    ? {}
    : {
        anonCharge: {
          term: `x ${anonMultiplier}`,
          label: 'anon mult',
          op: '*',
          modifier: (cost) => cost * anonMultiplier
        }
      }

  // Comments and bios: free while the monthly freebie quota lasts (bios are
  // always freebies); beyond the quota each comment costs the flat comment fee
  // (commentFeePiconeros — the postingFeeFloorPiconeros default) to the
  // platform rewards wallet.
  if (comment || bio) {
    const nonOwnedSubs = me ? subs.filter(s => Number(s.userId) !== Number(me.id)) : subs
    const ownerFree = subs.length > 0 && nonOwnedSubs.length === 0
    const freebie = ownerFree || !comment || (me?.privates?.freeCommentsLeft ?? 0) > 0
    const commentFee = me?.privates?.commentFeePiconeros
      ? BigInt(me.privates.commentFeePiconeros)
      : (me ? 0n : DEFAULT_POSTING_FEE_PICONEROS)
    if (freebie) {
      return {
        baseCost: {
          term: 1,
          label: comment ? 'comment' : 'post',
          op: '_',
          modifier: (cost) => cost + 1,
          allowFreebies: true,
          isComment: comment,
          ownerFree
        },
        ...anonCharge
      }
    }
    if (commentFee <= 0n) return { ...anonCharge }
    // the comment fee is FLAT: a replier's cost never scales with how many
    // turfs the root post's author chose to post to (ownerFree above already
    // waived it when the replier owns every turf in the thread)
    return {
      commentFee: {
        term: `+ ${piconerosToXmr(commentFee)}`,
        label: 'comment fee',
        // base line so the itemRepetition multiplier (op '*') scales it
        // server-side too: 0.001 x 1.5^n (sortHelper runs _ first, then * and /)
        op: '_',
        modifier: () => Number(commentFee / 1000n),
        allowFreebies: false,
        isComment: comment
      },
      ...anonCharge
    }
  }

  // Posts: the StasherNews posting fee is a flat on-chain Monero payment to the
  // platform rewards wallet (spec §6.2 Q5) — 0.001 XMR for low-rep authors,
  // nothing for established ones. Legacy per-turf baseCost lines are denominated
  // in sats and would misquote the fee, so posts render a single postingFee line
  // (or no lines at all when the author posts free).
  // Turf owners post free when ALL selected turfs are owned.
  const postNonOwned = me ? subs.filter(s => Number(s.userId) !== Number(me.id)) : subs
  const postOwnerFree = subs.length > 0 && postNonOwned.length === 0
  if (postOwnerFree) {
    return {
      baseCost: {
        term: 1,
        label: 'post',
        op: '_',
        modifier: (cost) => cost + 1,
        allowFreebies: true,
        isComment: false,
        ownerFree: true
      }
    }
  }

  const feePiconeros = me
    ? (me.privates?.postingFeeRequired ? BigInt(me.privates.postingFeePiconeros || 0) : 0n)
    : DEFAULT_POSTING_FEE_PICONEROS
  const freePostsLeft = me?.privates?.freePostsLeft ?? 0
  if (me && !me.privates?.postingFeeRequired && freePostsLeft > 0) {
    return {
      baseCost: {
        term: 1,
        label: 'post',
        op: '_',
        modifier: (cost) => cost + 1,
        allowFreebies: true,
        isComment: false
      },
      ...anonCharge
    }
  }
  const postMultiplier = subs.length === 0 ? 1 : postNonOwned.length
  // Turf premiums: each non-owned turf contributes its post premium on top of
  // the floor, mirroring the server fee math (postFeePiconerosForSubs = Σ
  // floor + premium). Shown as its OWN receipt line so the info modal explains
  // why the total exceeds the posting fee. Dormant deployments hold 0
  // everywhere (premiums are server-zeroed at every write path), so this
  // changes nothing when the feature is off. Free posts return above — premiums
  // never make a free post cost anything.
  const premiumTotalPiconeros = subs.length > 0
    ? postNonOwned.reduce((acc, s) => acc + BigInt(s?.postPremiumPiconeros ?? 0), 0n)
    : 0n
  const platformFeePiconeros = feePiconeros * BigInt(postMultiplier)
  const scaledFeePiconeros = platformFeePiconeros + premiumTotalPiconeros
  if (scaledFeePiconeros <= 0n) return {}

  return {
    postingFee: {
      term: `+ ${piconerosToXmr(platformFeePiconeros)}`,
      label: postMultiplier > 1 ? `posting fee \u00d7 ${postMultiplier} turfs` : 'posting fee',
      // base line so the itemRepetition multiplier (op '*') scales it. The
      // modifier ADDS to the accumulator (not absolute) because the premium
      // below is a second _ line — the provider's total reduce is assign-style
      // (modifier(acc)), so an absolute modifier would overwrite the premium's
      // contribution instead of summing it.
      op: '_',
      modifier: (cost) => cost + Number(platformFeePiconeros / 1000n),
      allowFreebies: false,
      isComment: false
    },
    // the turf owner premium is a separate charge (100% goes to the owner) on
    // top of the platform posting fee — its own base line keeps the receipt
    // breakdown honest; both _ lines add, and the * escalation/anon lines
    // scale the combined total exactly like the server.
    ...(premiumTotalPiconeros > 0n
      ? {
          turfPremium: {
            term: `+ ${piconerosToXmr(premiumTotalPiconeros)}`,
            label: 'turf owner premium',
            op: '_',
            modifier: (cost) => cost + Number(premiumTotalPiconeros / 1000n)
          }
        }
      : {}),
    ...anonCharge
  }
}

export function postCommentUseRemoteLineItems ({ parentId, subs = [] } = {}) {
  const query = parentId
    ? gql`{ itemRepetition(parentId: "${parentId}") }`
    : gql`{ itemRepetition }`

  return function useRemoteLineItems () {
    const { me } = useMe()
    const [line, setLine] = useState({})

    const { data } = useQuery(query, SSR ? {} : { pollInterval: FAST_POLL_INTERVAL_MS, nextFetchPolicy: 'cache-and-network' })

    const nonOwnedSubs = me ? subs.filter(s => Number(s.userId) !== Number(me.id)) : subs
    const multiplier = subs.length === 0 ? 1 : nonOwnedSubs.length

    useEffect(() => {
      const repetition = data?.itemRepetition
      // only show the x1.5^n line when a fee actually applies: a comment past the
      // freebie quota, or a low-rep post. Freebie comments (base 1) and free posts
      // must never be multiplied.
      const feeApplies = multiplier > 0 && (parentId
        ? (me?.privates?.freeCommentsLeft ?? 0) <= 0
        : !!me?.privates?.postingFeeRequired)
      if (!repetition || !feeApplies) return setLine({})
      setLine({
        itemRepetition: {
          term: <>x 1.5<sup>{repetition}</sup></>,
          label: <>{repetition} {parentId ? 'repeat or self replies' : 'posts'} in 10m</>,
          op: '*',
          modifier: (cost) => cost * Math.pow(
            Number(ITEM_SPAM_FEE_ESCALATION_NUMERATOR) / Number(ITEM_SPAM_FEE_ESCALATION_DENOMINATOR),
            repetition
          )
        }
      })
    }, [data?.itemRepetition, me?.privates?.freeCommentsLeft, me?.privates?.postingFeeRequired, multiplier])

    return line
  }
}

function sortHelper (a, b) {
  if (a.op === '_') {
    return -1
  } else if (b.op === '_') {
    return 1
  } else if (a.op === '*' || a.op === '/') {
    if (b.op === '*' || b.op === '/') {
      return 0
    }
    // a is higher precedence
    return -1
  } else {
    if (b.op === '*' || b.op === '/') {
      // b is higher precedence
      return 1
    }

    // postive first
    if (a.op === '+' && b.op === '-') {
      return -1
    }
    if (a.op === '-' && b.op === '+') {
      return 1
    }
    // both are + or -
    return 0
  }
}

const DEFAULT_BASE_LINE_ITEMS = {}
const DEFAULT_USE_REMOTE_LINE_ITEMS = () => null

export function FeeButtonProvider ({ baseLineItems = DEFAULT_BASE_LINE_ITEMS, useRemoteLineItems = DEFAULT_USE_REMOTE_LINE_ITEMS, children }) {
  const [lineItems, setLineItems] = useState({})
  const [disabledReasons, setDisabledReasons] = useState(() => new Set())
  const { me } = useMe()

  const remoteLineItems = useRemoteLineItems()

  // sets a submit disabled reason
  const setDisabled = useCallback((key, value) => {
    setDisabledReasons(prev => {
      const hasKey = prev.has(key)
      // avoid re-renders if the value is the same
      if (value === hasKey) return prev

      const next = new Set(prev)
      value ? next.add(key) : next.delete(key)
      return next
    })
  }, [])

  const mergeLineItems = useCallback((newLineItems) => {
    setLineItems(lineItems => ({
      ...lineItems,
      ...newLineItems
    }))
  }, [setLineItems])

  const value = useMemo(() => {
    const lines = { ...baseLineItems, ...lineItems, ...remoteLineItems }
    const total = Object.values(lines).sort(sortHelper).reduce((acc, { modifier }) => modifier(acc), 0)

    // Find base cost line item (could be 'baseCost' or '*-baseCost' for territories)
    const baseCostLine = Object.values(lines).find(line => line.op === '_' && line.allowFreebies !== undefined)

    // Freebies: there's only a base cost (no extra line items), the item type
    // allows freebies (comments/bios), and — for comments — the user has free
    // comments left this month. Posting free is the default; the user's balance
    // is irrelevant because the platform is non-custodial with no credits,
    // so there is no "can't afford" gate.
    const freeCommentsLeft = me?.privates?.freeCommentsLeft ?? 0
    const freePostsLeft = me?.privates?.freePostsLeft ?? 0
    const isComment = baseCostLine?.isComment
    const free = me &&
      total === baseCostLine?.modifier(0) &&
      baseCostLine?.allowFreebies &&
      (baseCostLine?.ownerFree || !isComment || freeCommentsLeft > 0)
    return {
      lines,
      merge: mergeLineItems,
      total,
      disabled: disabledReasons.size > 0,
      disabledReasons,
      setDisabled,
      free,
      freeCommentsLeft: isComment ? freeCommentsLeft : null,
      freePostsLeft: isComment === false ? freePostsLeft : null
    }
  }, [me, me?.privates?.freeCommentsLeft, me?.privates?.freePostsLeft, baseLineItems, lineItems, remoteLineItems, mergeLineItems, disabledReasons, setDisabled])

  return (
    <FeeButtonContext.Provider value={value}>
      {children}
    </FeeButtonContext.Provider>
  )
}

export function useFeeButton () {
  const context = useContext(FeeButtonContext)
  return context
}

function FreebieDialog ({ freeCommentsLeft, freePostsLeft }) {
  return (
    <>
      <div className='fw-bold'>this one is on us</div>
      <ul className='mt-2'>
        <li>Free items have limited visibility and can only earn credits.</li>
        {freeCommentsLeft !== null && (
          <li>You have {freeCommentsLeft} free comment{freeCommentsLeft !== 1 ? 's' : ''} left this month.</li>
        )}
        {freePostsLeft !== null && (
          <li>You have {freePostsLeft} free post{freePostsLeft !== 1 ? 's' : ''} left this month.</li>
        )}
        <li>To get fully visible right away, fund your account with a little XMR.</li>
      </ul>
    </>
  )
}

// The fee total is accumulated in legacy-sat units (1 sat = 1000 piconeros)
// and the x1.5^n spam escalation makes it fractional (e.g. 1e6 * 1.5^7 =
// 17085937.5). The server rounds the actual fee to whole piconeros
// (escalatedFeePiconeros); round the display the same way instead of letting
// BigInt(fractional) throw.
export function legacySatsToPiconeros (total) {
  return BigInt(Math.round(total || 0)) * 1000n
}

export default function FeeButton ({ ChildButton = SubmitButton, variant, text, disabled }) {
  const { me } = useMe()
  const { lines, total, disabled: ctxDisabled, free, freeCommentsLeft, freePostsLeft } = useFeeButton()
  const feeText = free
    ? 'free'
    : total > 1
      ? piconerosToXmr(legacySatsToPiconeros(total))
      : undefined
  disabled ||= ctxDisabled

  return (
    <div className={styles.feeButton}>
      <ActionTooltip overlayText={!free && total === 1 ? piconerosToXmr(1000n) : feeText}>
        <ChildButton
          variant={variant} disabled={disabled}
          appendText={feeText}
          submittingText={free || !feeText ? undefined : 'paying...'}
        >{text}
        </ChildButton>
      </ActionTooltip>
      {!me && <AnonInfo />}
      {(free && <Info><FreebieDialog freeCommentsLeft={freeCommentsLeft} freePostsLeft={freePostsLeft} /></Info>) ||
       (total > 1 && <Info><Receipt lines={lines} total={total} /></Info>)}
    </div>
  )
}

function Receipt ({ lines, total }) {
  return (
    <Table className={styles.receipt} borderless size='sm'>
      <tbody>
        {Object.entries(lines).sort(([, a], [, b]) => sortHelper(a, b)).map(([key, { term, label, omit }]) => (
          !omit &&
            <tr key={key}>
              <td>{term}</td>
              <td align='right' className='font-weight-light'>{label}</td>
            </tr>))}
      </tbody>
      <tfoot>
        <tr>
          <td className='fw-bold'>{piconerosToXmr(legacySatsToPiconeros(total))}</td>
          <td align='right' className='font-weight-light'>total fee</td>
        </tr>
      </tfoot>
    </Table>
  )
}

function AnonInfo () {
  const showModal = useShowModal()

  return (
    <AnonIcon
      className='ms-2 fill-theme-color pointer' height={22} width={22}
      onClick={
        (e) =>
          showModal(onClose =>
            <div><div className='fw-bold text-center'>You are posting without an account</div>
              <ol className='my-3'>
                <li>You'll pay by invoice</li>
                <li>Your content will be content-joined (get it?!) under the <Link href='/anon' target='_blank'>@anon</Link> account</li>
                <li>Any XMR your content earns will go toward <Link href='/rewards' target='_blank'>rewards</Link></li>
                <li>We won't be able to notify you when you receive replies</li>
              </ol>
              <small className='text-center fst-italic text-muted'>btw if you don't need to be anonymous, posting is cheaper with an account</small>
            </div>)
      }
    />
  )
}
