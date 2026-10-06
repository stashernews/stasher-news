import { useShowModal } from './modal'
import { useToast } from './toast'
import BoostModal from './boost-modal'
import { useMemo } from 'react'
import BoostIcon from '@/svgs/arrow-up-double-line.svg'
import styles from './upvote.module.css'
import classNames from 'classnames'
export default function Boost ({ item, className, ...props }) {
  const { boost } = item
  // promo credits rank the item too: the icon lights up for paid boosts or
  // promotional credits alike
  const promoted = Number(item.promoBoostPiconeros) > 0
  const lit = !!boost || promoted
  const color = useMemo(() => lit ? 'var(--bs-success)' : '#a5a5a5', [lit])

  const style = useMemo(() => ({
    '--hover-fill': 'var(--bs-success)',
    '--hover-filter': 'drop-shadow(0 0 6px var(--bs-success)90)',
    '--fill': color,
    '--filter': `drop-shadow(0 0 6px ${color}90)`
  }), [color])

  return (
    <Booster
      item={item} As={oprops =>
        <div className='upvoteParent' {...oprops}>
          <div
            className={classNames(styles.upvoteWrapper, item.deletedAt && styles.noSelfTips)}
          >
            <BoostIcon
              {...props}
              aria-hidden='true'
              focusable='false'
              style={style}
              width={26}
              height={26}
              className={classNames(styles.boost, className, lit && styles.boosted)}
            />
          </div>
        </div>}
    />
  )
}

function Booster ({ item, As, children }) {
  const toaster = useToast()
  const showModal = useShowModal()

  const openBoost = () => {
    try {
      showModal(onClose => <BoostModal item={item} onClose={onClose} />)
    } catch (error) {
      toaster.danger('failed to boost item')
    }
  }

  return (
    <As
      role='button'
      tabIndex={0}
      aria-label='boost'
      onClick={openBoost}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openBoost()
        }
      }}
    >
      {children}
    </As>
  )
}
