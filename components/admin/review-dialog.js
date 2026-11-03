import { useEffect, useRef, useState } from 'react'
import styles from '@/styles/admin.module.css'

export function ReviewDialog ({ changes, onApply, onClose, busy = false, error }) {
  const [reason, setReason] = useState('')
  const [retyped, setRetyped] = useState({})
  const dialog = useRef(null)
  const busyRef = useRef(busy)
  busyRef.current = busy
  useEffect(() => {
    const previous = document.activeElement
    dialog.current?.querySelector('button,textarea,input')?.focus()
    const keydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); if (!busyRef.current) onClose() }
      if (event.key !== 'Tab') return
      const controls = [...dialog.current.querySelectorAll('button:not(:disabled),textarea:not(:disabled),input:not(:disabled)')]
      const next = event.shiftKey ? controls.at(-1) : controls[0]
      if (!dialog.current.contains(document.activeElement) || document.activeElement === (event.shiftKey ? controls[0] : controls.at(-1))) { event.preventDefault(); next?.focus() }
    }
    document.addEventListener('keydown', keydown)
    return () => { document.removeEventListener('keydown', keydown); previous?.focus?.() }
  }, [onClose])
  const invalid = changes.some(change => change.error || (change.jump && retyped[change.field.key] !== change.value))
  const submit = event => {
    event.preventDefault()
    if (invalid || !reason.trim() || busy) return
    onApply(changes.map(change => ({ key: change.field.key, expected: change.expected, value: change.value, confirmedJump: !!change.jump })), reason)
  }
  return (
    <div className={styles.overlay}>
      <div ref={dialog} className={styles.dialog} role='dialog' aria-modal='true' aria-labelledby='review-title'>
        <div className={styles.heading}><h2 id='review-title'>Review & apply</h2><button type='button' disabled={busy} onClick={onClose} aria-label='Close review'>×</button></div>
        <p>One apply. One audit group. Every change is announced.</p>
        {error && <p role='alert' className={styles.warning}>{error}</p>}
        <form onSubmit={submit}>
          {changes.map(change => <div className={styles.reviewChange} key={change.field.key}><small>{change.field.section}</small><h3>{change.field.label}</h3><p><del>{change.expected}</del> → <strong>{change.value}</strong>{change.field.type === 'xmr' ? ' XMR' : ''}</p>{change.error && <p role='alert'>{change.error}</p>}{change.jump && <label>Large change — retype {change.value}<input autoComplete='off' value={retyped[change.field.key] ?? ''} disabled={busy} onInput={event => setRetyped({ ...retyped, [change.field.key]: event.currentTarget.value })} /></label>}</div>)}
          <label htmlFor='apply-reason'>Reason (required)</label><textarea id='apply-reason' value={reason} maxLength={500} disabled={busy} onInput={event => setReason(event.currentTarget.value)} />
          <div className={styles.actions}><button type='button' disabled={busy} onClick={onClose}>Back to edits</button><button className={styles.primary} type='submit' disabled={busy || invalid || !reason.trim()}>{busy ? 'Applying…' : `Apply ${changes.length} change${changes.length === 1 ? '' : 's'}`}</button></div>
        </form>
      </div>
    </div>
  )
}
