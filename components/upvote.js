import UpArrow from '@/svgs/up-arrow.svg'
import styles from './upvote.module.css'
import ActionTooltip from './action-tooltip'
import ItemAct from './item-act'
import TipModal from './tip-modal'
import { useMe } from './me'
import getColor from '@/lib/rainbow'
import { useMemo } from 'react'
import { piconerosToXmr } from '@/lib/format'
import { useShowModal } from './modal'
import { Dropdown } from 'react-bootstrap'
import classNames from 'classnames'

export function DropdownItemUpVote ({ item }) {
  const showModal = useShowModal()

  return (
    <Dropdown.Item
      onClick={async () => {
        showModal(onClose =>
          <ItemAct onClose={onClose} item={item} />)
      }}
    >
      <span className='text-success'>tip</span>
    </Dropdown.Item>
  )
}

export const defaultTipIncludingRandom = ({ tipDefault, tipRandom, tipRandomMin, tipRandomMax } = {}) => {
  return tipRandom
    ? Math.floor((Math.random() * (tipRandomMax - tipRandomMin + 1)) + tipRandomMin)
    : (tipDefault || 100000000)
}

export const nextTip = (meSats, { tipDefault, turboTipping, tipRandom, tipRandomMin, tipRandomMax }) => {
  if (turboTipping) {
    if (tipRandom) {
      let pow = 0
      // find the first power of 10 that is greater than meSats
      while (!(meSats <= tipRandomMax * 10 ** pow)) {
        pow++
      }
      // if meSats is in that power of 10's range already, move into the next range
      if (meSats >= tipRandomMin * 10 ** pow) {
        pow++
      }
      // make sure the our range minimum doesn't overlap with the previous range maximum
      tipRandomMin = tipRandomMax * 10 ** (pow - 1) >= tipRandomMin * 10 ** pow ? tipRandomMax * 10 ** (pow - 1) + 1 : tipRandomMin * 10 ** pow
      tipRandomMax = tipRandomMax * 10 ** pow
      return Math.floor((Math.random() * (tipRandomMax - tipRandomMin + 1)) + tipRandomMin) - meSats
    }

    let sats = defaultTipIncludingRandom({ tipDefault, tipRandom, tipRandomMin, tipRandomMax })
    while (meSats >= sats) {
      sats *= 10
    }
    // deduct current sats since turbo tipping is about total zap not making the next zap 10x
    return sats - meSats
  }

  return defaultTipIncludingRandom({ tipDefault, tipRandom, tipRandomMin, tipRandomMax })
}

export default function UpVote ({ item, className, collapsed }) {
  const showModal = useShowModal()
  const { me } = useMe()

  const disabled = useMemo(() => collapsed || item?.mine || item?.meForward || item?.deletedAt,
    [collapsed, item?.mine, item?.meForward, item?.deletedAt])

  const [meSats, overlayText, color, nextColor] = useMemo(() => {
    const meSats = Number(me ? item?.mePiconeros : item?.meAnonPiconeros) || 0

    // what should our next tip be?
    const sats = nextTip(meSats, { ...me?.privates })
    let overlayTextContent
    if (me) {
      overlayTextContent = me.privates?.tipRandom ? 'random' : piconerosToXmr(BigInt(sats))
    } else {
      overlayTextContent = 'tip it'
    }

    return [
      meSats, overlayTextContent,
      getColor(meSats), getColor(meSats + sats)]
  }, [
    me, item?.mePiconeros, item?.meAnonPiconeros, me?.privates?.tipDefault, me?.privates?.turboDefault,
    me?.privates?.tipRandom, me?.privates?.tipRandomMin, me?.privates?.tipRandomMax])

  const handlePress = () => {
    if (!item || disabled) return
    showModal(onClose => <TipModal item={item} onClose={onClose} />)
  }

  const style = useMemo(() => ({
    '--hover-fill': nextColor,
    '--hover-filter': `drop-shadow(0 0 6px ${nextColor}90)`,
    '--fill': color,
    '--filter': `drop-shadow(0 0 6px ${color}90)`
  }), [color, nextColor])

  return (
    <div className='upvoteParent' onClick={handlePress}>
      <ActionTooltip notForm disable={disabled} overlayText={overlayText}>
        <div className={classNames(disabled && styles.noSelfTips, styles.upvoteWrapper)}>
          <UpArrow
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
