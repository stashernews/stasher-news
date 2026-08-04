import UpBolt from '@/svgs/bolt.svg'
import styles from './upvote.module.css'
import { gql } from '@apollo/client'
import { useMutation } from '@apollo/client/react'
import ActionTooltip from './action-tooltip'
import ItemAct from './item-act'
import TipModal from './tip-modal'
import { useMe } from './me'
import getColor from '@/lib/rainbow'
import { useCallback, useMemo, useRef, useState } from 'react'
import { piconerosToXmr } from '@/lib/format'
import LongPressable from './long-pressable'
import Overlay from 'react-bootstrap/Overlay'
import Popover from 'react-bootstrap/Popover'
import { useShowModal } from './modal'
import { Dropdown } from 'react-bootstrap'
import classNames from 'classnames'

const UpvotePopover = ({ target, show, handleClose }) => {
  const { me } = useMe()
  return (
    <Overlay
      show={show}
      target={target}
      placement='right'
    >
      <Popover id='popover-basic'>
        <Popover.Header className='d-flex justify-content-between alert-dismissible' as='h4'>Tipping
          <button type='button' className='btn-close' onClick={handleClose}><span className='visually-hidden-focusable'>Close alert</span></button>
        </Popover.Header>
        <Popover.Body>
          <div className='mb-2'>Press the tip button again to tip {me?.privates?.tipRandom ? 'a random amount' : `${piconerosToXmr(BigInt(me?.privates?.tipDefault || 1))} more`}.</div>
          <div>Repeatedly press the tip button to tip more.</div>
        </Popover.Body>
      </Popover>
    </Overlay>
  )
}

const TipPopover = ({ target, show, handleClose }) => (
  <Overlay
    show={show}
    target={target}
    placement='right'
  >
    <Popover id='popover-basic'>
      <Popover.Header className='d-flex justify-content-between alert-dismissible' as='h4'>Press and hold
        <button type='button' className='btn-close' onClick={handleClose}><span className='visually-hidden-focusable'>Close alert</span></button>
      </Popover.Header>
      <Popover.Body>
        <div className='mb-2'>Press and hold the tip button to tip a custom amount.</div>
        <div>As you tip more, the tip button color follows the rainbow.</div>
      </Popover.Body>
    </Popover>
  </Overlay>
)

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
  const [voteShow, _setVoteShow] = useState(false)
  const [tipShow, _setTipShow] = useState(false)
  const ref = useRef()
  const { me } = useMe()
  const [setWalkthrough] = useMutation(
    gql`
      mutation setWalkthrough($upvotePopover: Boolean, $tipPopover: Boolean) {
        setWalkthrough(upvotePopover: $upvotePopover, tipPopover: $tipPopover)
      }`
  )

  const setVoteShow = useCallback((yes) => {
    if (!me) return

    // if they haven't seen the walkthrough and they have sats
    if (yes && !me.privates?.upvotePopover && me.privates?.piconeros) {
      _setVoteShow(true)
    }

    if (voteShow && !yes) {
      _setVoteShow(false)
      setWalkthrough({ variables: { upvotePopover: true } })
    }
  }, [me, voteShow, setWalkthrough])
  const setTipShow = useCallback((yes) => {
    if (!me) return

    // if we want to show it, yet we still haven't shown
    if (yes && !me.privates?.tipPopover && me.privates?.piconeros) {
      _setTipShow(true)
    }

    // if it's currently showing and we want to hide it
    if (tipShow && !yes) {
      _setTipShow(false)
      setWalkthrough({ variables: { tipPopover: true } })
    }
  }, [me, tipShow, setWalkthrough])

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

  const handleLongPress = (e) => {
    if (!item || disabled) return
    setTipShow(false)
    showModal(onClose => <TipModal item={item} onClose={onClose} />)
  }

  const handleShortPress = () => {
    if (!me) {
      showModal(onClose => <TipModal item={item} onClose={onClose} />)
      return
    }
    if (!item || disabled) return
    if (meSats) {
      setVoteShow(false)
    } else {
      setTipShow(true)
    }
    showModal(onClose => <TipModal item={item} onClose={onClose} />)
  }

  const style = useMemo(() => ({
    '--hover-fill': nextColor,
    '--hover-filter': `drop-shadow(0 0 6px ${nextColor}90)`,
    '--fill': color,
    '--filter': `drop-shadow(0 0 6px ${color}90)`
  }), [color, nextColor])

  return (
    <div ref={ref} className='upvoteParent'>
      <LongPressable
        onLongPress={handleLongPress}
        onShortPress={handleShortPress}
      >
        <ActionTooltip notForm disable={disabled} overlayText={overlayText}>
          <div className={classNames(disabled && styles.noSelfTips, styles.upvoteWrapper)}>
            <UpBolt
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
      </LongPressable>
      <TipPopover target={ref.current} show={tipShow} handleClose={() => setTipShow(false)} />
      <UpvotePopover target={ref.current} show={voteShow} handleClose={() => setVoteShow(false)} />
    </div>
  )
}
