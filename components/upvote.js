import UpArrow from '@/svgs/up-arrow.svg'
import styles from './upvote.module.css'
import ActionTooltip from './action-tooltip'
import TipModal from './tip-modal'
import { useMe } from './me'
import { useMemo } from 'react'
import { piconerosToMXmr } from '@/lib/format'
import { useShowModal } from './modal'
import { Dropdown } from 'react-bootstrap'
import classNames from 'classnames'

export function DropdownItemUpVote ({ item }) {
  const showModal = useShowModal()

  return (
    <Dropdown.Item
      onClick={() => showModal(onClose => <TipModal item={item} onClose={onClose} />)}
    >
      <span className='text-success'>tip</span>
    </Dropdown.Item>
  )
}

export const defaultTipIncludingRandom = ({ tipDefault, tipRandom, tipRandomMin, tipRandomMax } = {}) => {
  return tipRandom
    ? Math.floor((Math.random() * (Number(tipRandomMax) - Number(tipRandomMin) + 1)) + Number(tipRandomMin))
    : (Number(tipDefault) || 1000000000)
}

export default function UpVote ({ item, className, collapsed }) {
  const showModal = useShowModal()
  const { me } = useMe()

  const disabled = useMemo(() => collapsed || item?.mine || item?.deletedAt,
    [collapsed, item?.mine, item?.deletedAt])

  const [meSats, overlayText, color] = useMemo(() => {
    const meSats = Number(me ? item?.mePiconeros : item?.meAnonPiconeros) || 0

    // what should our next tip be?
    const sats = defaultTipIncludingRandom({ ...me?.privates })
    let overlayTextContent
    if (me) {
      overlayTextContent = me.privates?.tipRandom ? 'random' : piconerosToMXmr(BigInt(sats))
    } else {
      overlayTextContent = 'tip it'
    }

    return [
      meSats, overlayTextContent,
      meSats ? 'var(--bs-success)' : '#a5a5a5']
  }, [
    me, item?.mePiconeros, item?.meAnonPiconeros, me?.privates?.tipDefault,
    me?.privates?.tipRandom, me?.privates?.tipRandomMin, me?.privates?.tipRandomMax])

  const handlePress = () => {
    if (!item || disabled) return
    showModal(onClose => <TipModal item={item} onClose={onClose} />)
  }

  const style = useMemo(() => ({
    '--hover-fill': 'var(--bs-success)',
    '--hover-filter': 'drop-shadow(0 0 6px var(--bs-success)90)',
    '--fill': color,
    '--filter': `drop-shadow(0 0 6px ${color}90)`
  }), [color])

  return (
    // skeletons render us without an item: keep them out of the a11y tree and tab order
    <div
      className='upvoteParent'
      onClick={handlePress}
      {...(item
        ? {
            role: 'button',
            tabIndex: 0,
            'aria-label': 'upvote',
            'aria-disabled': disabled || undefined,
            onKeyDown: (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                handlePress()
              }
            }
          }
        : {})}
    >
      <ActionTooltip notForm disable={disabled} overlayText={overlayText}>
        <div className={classNames(disabled && styles.noSelfTips, styles.upvoteWrapper)}>
          <UpArrow
            aria-hidden='true'
            focusable='false'
            width={26}
            height={26}
            className={classNames(styles.upvote,
              className,
              disabled && styles.noSelfTips,
              meSats && styles.voted)}
            style={style}
          />
        </div>
      </ActionTooltip>
    </div>
  )
}
