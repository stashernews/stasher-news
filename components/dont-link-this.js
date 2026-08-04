import Dropdown from 'react-bootstrap/Dropdown'
import { useShowModal } from './modal'
import { useToast } from './toast'
import DownvoteModal from './downvote-modal'
import Flag from '@/svgs/flag-fill.svg'
import { useMemo } from 'react'
import getColor from '@/lib/rainbow'
import styles from './upvote.module.css'

export function DownZap ({ item, ...props }) {
  const { meDontLikePiconeros } = item
  const style = useMemo(() => (meDontLikePiconeros
    ? {
        fill: getColor(meDontLikePiconeros),
        filter: `drop-shadow(0 0 6px ${getColor(meDontLikePiconeros)}90)`
      }
    : undefined), [meDontLikePiconeros])
  return (
    <DownZapper
      item={item} As={({ ...oprops }) =>
        <div className='upvoteParent'>
          <div className={styles.upvoteWrapper}>
            <Flag {...props} {...oprops} style={style} />
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
