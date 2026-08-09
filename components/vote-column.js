import UpVote from './upvote'
import DownArrow from '@/svgs/down-arrow.svg'
import { useShowModal } from './modal'
import DownvoteModal from './downvote-modal'

// Up arrow + visible downvote arrow (rebrand layout). The downvote opens the
// same modal the ⋮ menu uses — both affordances stay functional. Rendered by
// item.js only when the rebrand flag is on; flag-off keeps the upvote-only
// column exactly as before.
export default function VoteColumn ({ item, className, collapsed }) {
  const showModal = useShowModal()
  const openDownvote = () => showModal(onClose => <DownvoteModal item={item} onClose={onClose} />)

  return (
    <div className='d-flex flex-column align-items-center'>
      <UpVote item={item} className={className} collapsed={collapsed} />
      <span
        role='button' aria-label='downvote' tabIndex={0}
        onClick={openDownvote}
        onKeyDown={(e) => { if (e.key === 'Enter') openDownvote() }}
        className='downvoteArrow text-muted d-block mt-0'
        style={{ cursor: 'pointer', lineHeight: 1 }}
        title='downvote'
      >
        <DownArrow width={26} height={26} className={className} />
      </span>
    </div>
  )
}
