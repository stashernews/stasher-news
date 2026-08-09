import UpVote from './upvote'
import { useShowModal } from './modal'
import DownvoteModal from './downvote-modal'

// Up arrow + visible downvote chevron (rebrand layout). The downvote opens the
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
        className='text-muted d-block mt-0'
        style={{ cursor: 'pointer', lineHeight: 1, opacity: 0.65 }}
        title='downvote'
      >
        {/* down chevron */}
        <svg width='26' height='14' viewBox='0 0 26 14' fill='currentColor' xmlns='http://www.w3.org/2000/svg'>
          <path d='M13 14L0 0h26L13 14z' />
        </svg>
      </span>
    </div>
  )
}
