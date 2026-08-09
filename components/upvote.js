import UpArrow from '@/svgs/up-arrow.svg'
import styles from './upvote.module.css'
import ActionTooltip from './action-tooltip'
import TipModal from './tip-modal'
import { useMe } from './me'
import getColor from '@/lib/rainbow'
import { useRebrand } from '@/lib/rebrand'
import { useMemo } from 'react'
import { piconerosToXmr } from '@/lib/format'
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
  const rebrand = useRebrand()

  const disabled = useMemo(() => collapsed || item?.mine || item?.deletedAt,
    [collapsed, item?.mine, item?.deletedAt])

  const [meSats, overlayText, color, nextColor] = useMemo(() => {
    const meSats = Number(me ? item?.mePiconeros : item?.meAnonPiconeros) || 0

    // what should our next tip be?
    const sats = defaultTipIncludingRandom({ ...me?.privates })
    let overlayTextContent
    if (me) {
      overlayTextContent = me.privates?.tipRandom ? 'random' : piconerosToXmr(BigInt(sats))
    } else {
      overlayTextContent = 'tip it'
    }

    return [
      meSats, overlayTextContent,
      getColor(meSats, rebrand), getColor(meSats + sats, rebrand)]
  }, [
    me, item?.mePiconeros, item?.meAnonPiconeros, me?.privates?.tipDefault,
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
