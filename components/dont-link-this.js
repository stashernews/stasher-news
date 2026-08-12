import Dropdown from 'react-bootstrap/Dropdown'
import { useShowModal } from './modal'
import { useToast } from './toast'
import DownvoteModal from './downvote-modal'
import Flag from '@/svgs/flag-fill.svg'
import { useMemo } from 'react'
import getColor from '@/lib/rainbow'
import styles from './upvote.module.css'
import classNames from 'classnames'

export function DownZap ({ item, className, ...props }) {
  const { meDontLikePiconeros } = item
  const color = getColor(meDontLikePiconeros)
  const style = useMemo(() => ({
    '--hover-fill': 'var(--bs-danger)',
    '--hover-filter': 'drop-shadow(0 0 6px var(--bs-danger)90)',
    ...(meDontLikePiconeros
      ? { fill: color, filter: `drop-shadow(0 0 6px ${color}90)` }
      : {})
  }), [meDontLikePiconeros, color])
  return (
    <DownZapper
      item={item} As={({ ...oprops }) =>
        <div className='upvoteParent'>
          <div className={styles.upvoteWrapper}>
            <Flag
              {...props} {...oprops} style={style}
              className={classNames(styles.downvote, className)}
            />
          </div>
        </div>}
    />
  )
}

function DownZapper ({ item, As, children }) {
  const toaster = useToast()
  const showModal = useShowModal()

  return (
    <As
      onClick={async () => {
        try {
          showModal(onClose =>
            <DownvoteModal item={item} onClose={onClose} />)
        } catch (error) {
          toaster.danger('failed to downvote item')
        }
      }}
    >
      {children}
    </As>
  )
}

export default function DontLikeThisDropdownItem ({ item }) {
  return (
    <DownZapper
      As={Dropdown.Item}
      item={item}
    >
      <span className='text-danger'>downvote</span>
    </DownZapper>
  )
}
