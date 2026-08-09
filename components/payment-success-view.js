import { useEffect, useRef } from 'react'
import { DISPLAY_FONT, useRebrand } from '@/lib/rebrand'
import Keyhole from '@/svgs/keyhole.svg'

// Message-only "payment detected" success state shared by the tip and downvote
// modals. Presentational: the parent owns modal close, but when autoCloseMs is a
// positive number this fires onAutoClose once after that delay. The parent clears
// the timer on unmount.
export default function PaymentSuccessView ({ title, note, autoCloseMs, onAutoClose }) {
  const rebrand = useRebrand()
  const timerRef = useRef(null)

  useEffect(() => {
    if (autoCloseMs > 0 && typeof onAutoClose === 'function') {
      timerRef.current = setTimeout(onAutoClose, autoCloseMs)
      return () => { clearTimeout(timerRef.current) }
    }
  }, [autoCloseMs, onAutoClose])

  return (
    <div className='d-flex flex-column align-items-center text-center'>
      {rebrand &&
        <div className='stealth-success-ring'>
          <Keyhole className='stealth-success-glyph' />
        </div>}
      <h6 style={rebrand ? { fontFamily: DISPLAY_FONT } : undefined}>{title}</h6>
      {note &&
        <p className='text-muted mt-2'>
          <small>{note}</small>
        </p>}
    </div>
  )
}
