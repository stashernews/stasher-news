import UpVote from './upvote'
import DownArrow from '@/svgs/down-arrow.svg'
import { useShowModal } from './modal'
import DownvoteModal from './downvote-modal'
import classNames from 'classnames'
import styles from './upvote.module.css'

// Up arrow + visible downvote arrow (rebrand layout). The downvote opens the
// same modal the ⋮ menu uses — both affordances stay functional. Rendered by
// item.js and comment.js for every non-mine item. The down arrow is grey by
// default and danger-red once the viewer has downvoted; collapsed comments hide
// both arrows.
export default function VoteColumn ({ item, className, collapsed }) {
  const showModal = useShowModal()
  const openDownvote = () => showModal(onClose => <DownvoteModal item={item} onClose={onClose} />)
  const downvoted = Number(item?.meDontLikePiconeros) > 0

  return (
    <div className='d-flex flex-column align-items-center'>
      <UpVote item={item} className={className} collapsed={collapsed} />
      <span
        role='button' aria-label='downvote' tabIndex={0}
        onClick={openDownvote}
        onKeyDown={(e) => { if (e.key === 'Enter') openDownvote() }}
        className={classNames('downvoteArrow d-block mt-0',
          downvoted ? 'downvoteArrowActive' : 'text-muted',
          collapsed && styles.downvoteCollapsed)}
        style={{ cursor: 'pointer', lineHeight: 1 }}
        title='downvote'
      >
        <DownArrow width={26} height={26} className={className} />
      </span>
    </div>
  )
}
