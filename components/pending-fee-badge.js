import Badge from 'react-bootstrap/Badge'
import styles from './item.module.css'
import { moneroUriAmountPiconeros, underpayHint } from '@/lib/format'

export default function PendingFeeBadge ({ item }) {
  if (item?.feeStatus !== 'PENDING_FEE' || item?.deletedAt) return null

  return (
    <span>
      {' '}<Badge className={styles.newComment} bg={null}>pending payment</Badge>
      {item.payIn?.moneroUri &&
        <span className='ms-1 text-warning' style={{ fontSize: '0.85rem' }}>
          {underpayHint(BigInt(item.feeReceivedPiconeros ?? 0), moneroUriAmountPiconeros(item.payIn.moneroUri))}
        </span>}
    </span>
  )
}
