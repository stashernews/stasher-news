import Dropdown from 'react-bootstrap/Dropdown'
import { useShowModal } from './modal'
import { useToast } from './toast'
import DownvoteModal from './downvote-modal'

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
