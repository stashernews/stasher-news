import { fieldError } from './drafts'
import styles from '@/styles/admin.module.css'

function Choice ({ field, value, onChange }) {
  const options = field.type === 'enum' ? field.options : ['true', 'false', ...(field.type === 'nullableBool' ? ['null'] : [])]
  return <div id={`field-${field.key}`} className={styles.choices} role='group' aria-label={field.label}>{options.map(option => <button key={option} type='button' disabled={field.locked} aria-pressed={value === option} onClick={() => onChange(option)}>{option === 'null' ? 'Reset to env' : option === 'true' ? 'On' : option === 'false' ? 'Off' : option}</button>)}</div>
}

export function FieldRow ({ field, draft, onChange, onRevert }) {
  const value = draft?.value ?? field.value
  const error = draft ? fieldError(field, value) : null
  const choices = ['bool', 'nullableBool', 'enum'].includes(field.type)
  const id = `field-${field.key}`
  const unit = field.unit ?? ({ xmr: 'XMR', pct: '%', bps: 'bps' }[field.type] || '')
  return (
    <div className={`${styles.field} ${draft ? styles.modified : ''}`}>
      <div><label htmlFor={choices ? undefined : id}>{field.label}</label>{field.experimental && <span className={styles.tag}>Experimental</span>}{draft && <span className={styles.tag}>Modified</span>}<p className={styles.help} id={`${id}-help`}>{field.help}</p><small>{field.takesEffect === 'cache' ? 'Takes effect within 60 seconds' : field.takesEffect.replace('nextRun:', 'Next ').replace('nextWalk', 'Next trust walk')}</small></div>
      <div className={styles.control}>
        {field.type === 'text' && <><textarea id={id} value={value} rows={3} maxLength={field.maxLength} disabled={field.locked} aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`} aria-invalid={!!error} onInput={event => onChange(event.currentTarget.value)} /><small>{value.length} / {field.maxLength} characters</small></>}
        {field.type === 'text' ? null : choices ? <Choice field={field} value={value} onChange={onChange} /> : <div className={styles.inputUnit}><input id={id} value={value} disabled={field.locked} inputMode={field.type === 'idList' ? 'text' : 'decimal'} aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`} aria-invalid={!!error} autoComplete='off' onInput={event => onChange(event.currentTarget.value)} /><span>{unit}</span></div>}
        {field.type === 'bps' && !error && <small>{Number(value) / 10000}× · {Number(value) / 100}%</small>}
        <small>Live <strong>{field.type === 'text' && !field.value ? '(empty)' : field.value}</strong>{field.source === 'env' && <> · effective {field.effectiveValue} (env)</>}</small>
        {field.effectiveReason && <small>{field.effectiveReason}</small>}
        {field.locked && <p className={styles.warning}>Locked · {field.lockReason}</p>}
        {field.key === 'maintenance' && <small>SSH fallback: <code>touch docker/caddy/maintenance-flag/enabled</code> to enable; <code>rm docker/caddy/maintenance-flag/enabled</code> to disable.</small>}
        {error && <p id={`${id}-error`} className={styles.warning} role='alert'>{error}</p>}
        {draft && <button className={styles.textButton} type='button' onClick={onRevert}>Revert</button>}
      </div>
    </div>
  )
}
