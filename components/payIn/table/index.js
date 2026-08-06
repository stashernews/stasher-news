import styles from '../table/index.module.css'
import classNames from 'classnames'
import { PayInType } from './type'
import { PayInContext } from '../context'
import { PayInMoney } from './money'
import LinkToContext from '@/components/link-to-context'

export default function PayInTable ({ payIns }) {
  return (
    <div className={styles.table}>
      <div className={classNames(styles.row, styles.header)}>
        <div>type</div>
        <div>context</div>
        <div>XMR</div>
      </div>
      {payIns?.map(payIn => (
        <PayInRow key={`${payIn.id}-${payIn.isSend}`} payIn={payIn} />
      ))}
    </div>
  )
}

// Every history row is observation-backed and links to the thing it's about:
// posting/downvote/tip rows → their post; territory-fee rows → their turf.
// (Real PayIn rows reaching this table would fall through to /transactions.)
function payInHref (payIn) {
  if (payIn.item?.id) {
    return `/items/${payIn.item.id}`
  }
  if (payIn.subPayIn?.subName) {
    return `/~/${payIn.subPayIn.subName}`
  }
  return `/transactions/${payIn.id}`
}

function PayInRow ({ payIn }) {
  return (
    <div
      className={classNames(styles.row, {
        [styles.failed]: payIn.payInState === 'FAILED',
        [styles.spending]: !!payIn?.payerPrivates,
        [styles.stacking]: !payIn?.payerPrivates
      })}
    >
      <LinkToContext className={styles.type} href={payInHref(payIn)}>
        <PayInType payIn={payIn} />
      </LinkToContext>
      <LinkToContext className={styles.context} href={payInHref(payIn)}>
        <div className='d-flex d-sm-none small justify-content-center text-muted w-100' />
        <div className='d-none d-sm-block mw-100'><PayInContext payIn={payIn} /></div>
      </LinkToContext>
      <LinkToContext className={styles.money} href={payInHref(payIn)}>
        <PayInMoney payIn={payIn} />
      </LinkToContext>
    </div>
  )
}

export function PayInSkeleton ({ header }) {
  return (
    <div className={styles.table}>
      {header &&
        <div className={classNames(styles.row, styles.header, 'clouds')}>
          <div>type</div>
          <div>context</div>
          <div>XMR</div>
        </div>}
      {Array.from({ length: 21 }).map((_, index) => (
        <div className={classNames(styles.row, styles.skeleton, 'clouds')} key={index}>
          <div className={classNames(styles.type, 'clouds')} />
          <div className={classNames(styles.context, 'clouds')} />
          <div className={classNames(styles.money, 'clouds')} />
        </div>
      ))}
    </div>
  )
}
