import { FAILED_PAY_IN_STATES } from '@/lib/pay-in'
import Moon from '@/svgs/moon-fill.svg'
import Check from '@/svgs/check-double-line.svg'
import ThumbDown from '@/svgs/thumb-down-fill.svg'

const statusIconSize = 16

function StatusText ({ color, children }) {
  return (
    <small className={`ms-1 text-${color}`} style={{ fontWeight: '600' }}>{children}</small>
  )
}

export function PayInStatus ({ payIn }) {
  const settling = payIn.payInState !== 'PAID' && !FAILED_PAY_IN_STATES.includes(payIn.payInState)

  return (
    <div className='d-flex align-items-center'>
      {(payIn.payInState === 'PAID' && <><Check width={statusIconSize} height={statusIconSize} className='fill-success' /><StatusText color='success'>{payIn.piconeros > 0 ? 'paid' : 'free'}</StatusText></>) ||
        (FAILED_PAY_IN_STATES.includes(payIn.payInState) && <><ThumbDown width={statusIconSize} height={statusIconSize} className='fill-danger' /><StatusText color='danger'>failed</StatusText></>) ||
        (settling && <><Moon width={statusIconSize} height={statusIconSize} className='spin fill-grey' /><StatusText color='muted'>settling</StatusText></>)}
    </div>
  )
}

export function PayInStatusSkeleton () {
  return (
    <div className='d-flex align-items-center'>
      <div className='clouds' style={{ width: statusIconSize, height: statusIconSize }} />
      <StatusText color='muted'>loading</StatusText>
    </div>
  )
}
