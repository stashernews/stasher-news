import Button from 'react-bootstrap/Button'
import { isPendingFeeItem } from '@/lib/pay-in'
import PostingFeeModal from './posting-fee-modal'
import { useShowModal } from './modal'

export default function PayPostingFeeButton ({ item }) {
  const showModal = useShowModal()

  if (!isPendingFeeItem(item) || !item.payIn?.moneroUri) return null

  return (
    <>{' '}
      <Button
        size='sm' variant='outline-danger'
        onClick={() => showModal((onClose) => <PostingFeeModal moneroUri={item.payIn.moneroUri} itemId={item.id} />)}
      >
        pay the {item.parentId ? 'comment' : 'posting'} fee
      </Button>
    </>
  )
}
