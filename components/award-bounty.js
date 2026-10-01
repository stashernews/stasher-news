import styles from './award-bounty.module.css'
import { useMe } from './me'
import { useRoot } from './root'
import { useShowModal } from './modal'
import { AwardBountyModal } from './bounty-actions'

// Inline award control on comments under a funded bounty post (A-13): the
// visible replacement for the old three-dots dropdown item. Renders only for
// the bounty post's author, on someone else's live comment, and only once the
// bounty is FUNDED — the same conditions the server's payBounty enforces, so
// the button never shows a state the server would reject. Opens the shared
// AwardBountyModal: same mutation, escrow payout queue, cache status update
// and toasts as before.
export default function AwardBounty ({ item }) {
  const { me } = useMe()
  const showModal = useShowModal()
  const root = useRoot()

  if (!me || !item.parentId || item.mine || item.deletedAt) return null
  if (root.bountyStatus !== 'FUNDED' || Number(root.user?.id) !== Number(me.id)) return null

  return (
    <div
      className={styles.award} onClick={() => {
        showModal(onClose => <AwardBountyModal item={item} root={root} onClose={onClose} />)
      }}
    >
      award bounty
    </div>
  )
}
