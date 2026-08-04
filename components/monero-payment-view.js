import Qr from './qr'
import { CopyButton } from './form'
import { moneroUriAddress, piconerosToXmr } from '@/lib/format'

export default function MoneroPaymentView ({ moneroUri, amountPiconeros, heading, description, children }) {
  const address = moneroUriAddress(moneroUri)
  return (
    <div className='d-flex flex-column align-items-center'>
      {heading && <h6>{heading}</h6>}
      <p className='text-muted text-center'>
        {description ?? `Scan to send ${piconerosToXmr(amountPiconeros)}.`}
      </p>
      <Qr value={moneroUri} />
      {address &&
        <div className='mt-2 w-100' style={{ maxWidth: '320px' }}>
          <div className='input-group'>
            <input
              type='text' readOnly value={address}
              className='form-control text-break text-monospace small'
              style={{ fontSize: '0.75rem' }}
              onFocus={(e) => e.target.select()}
            />
            <CopyButton value={address} icon />
          </div>
        </div>}
      <div className='mt-2'>
        <a href={moneroUri} className='fw-bold text-decoration-underline'>Open in Desktop Monero Wallet</a>
      </div>
      <p className='text-muted text-center mt-3'>
        <small>
          You can close this window right after sending, your payment is detected on-chain automatically.
        </small>
      </p>
      {children}
    </div>
  )
}
