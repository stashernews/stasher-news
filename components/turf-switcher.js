import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { ACTIVE_SUBS } from '@/fragments/subs'
import { useGoToSub, useSubs } from './sub-select'

const PREPEND_SUBS = ['frontpage']

// one plain-text line of a turf description (drops markdown images/links/headings)
const blurb = desc => (desc || '')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .split('\n').map(l => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) || ''

// Searchable turf switcher for the top bars. Same destinations and same
// navigation as the native turf <select> it replaces (useGoToSub): frontpage,
// joined turfs, muted turfs, and "create a turf". Accessibility: the trigger
// keeps the select's accessible name ("location: <turf>"), the popover is a
// labelled dialog, rows are real buttons in a list (current turf marked with
// aria-current), Escape closes and returns focus to the trigger, and
// ArrowUp/ArrowDown move focus between the search box and the rows.
export default function TurfSwitcher ({ sub: subName, className }) {
  const sub = subName || 'frontpage'
  const goToSub = useGoToSub()
  const subs = useSubs({ prependSubs: PREPEND_SUBS, sub: subName })
  const { data } = useQuery(ACTIVE_SUBS)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const root = useRef(null)
  const trigger = useRef(null)
  const input = useRef(null)
  const list = useRef(null)

  const descs = useMemo(() => Object.fromEntries((data?.activeSubs || []).map(s => [s.name, s.desc])), [data])

  const { joined, muted } = useMemo(() => {
    const flat = []
    const mutedItems = []
    subs.forEach(s => {
      if (typeof s === 'string') flat.push(s)
      else if (s?.label === 'muted') mutedItems.push(...s.items)
    })
    if (!flat.includes(sub) && !mutedItems.includes(sub)) flat.push(sub)
    const needle = q.trim().toLowerCase()
    const match = n => !needle || n.toLowerCase().includes(needle)
    return { joined: flat.filter(match), muted: mutedItems.filter(match) }
  }, [subs, sub, q])

  const close = useCallback((refocus = true) => {
    setOpen(false)
    setQ('')
    if (refocus) trigger.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    input.current?.focus()
    const onDown = e => { if (root.current && !root.current.contains(e.target)) close(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
    }
  }, [open, close])

  const pick = useCallback(name => {
    close(false)
    goToSub(name)
  }, [close, goToSub])

  const rows = () => Array.from(list.current?.querySelectorAll('button') || [])

  const onKeyDown = e => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const items = [input.current, ...rows()]
      const at = items.indexOf(document.activeElement)
      const next = e.key === 'ArrowDown' ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1)
      items[next]?.focus()
    } else if (e.key === 'Enter' && document.activeElement === input.current) {
      const first = joined[0] ?? muted[0]
      if (first) pick(first)
    }
  }

  const row = (name, isMuted) => (
    <li key={name}>
      <button
        type='button'
        className={`turf-row${name === sub ? ' is-current' : ''}${isMuted ? ' is-muted' : ''}`}
        aria-current={name === sub ? 'true' : undefined}
        onClick={() => pick(name)}
      >
        <span className='turf-caret-mark' aria-hidden='true'>{name === sub ? '>' : ''}</span>
        <span className='d-flex flex-column' style={{ minWidth: 0 }}>
          <span className='turf-name'>{name === 'frontpage' ? name : `~${name}`}</span>
          {!isMuted && blurb(descs[name]) &&
            <span className='text-muted text-truncate' style={{ fontSize: '0.75rem' }}>{blurb(descs[name])}</span>}
        </span>
      </button>
    </li>
  )

  return (
    <div className={`turf-switcher ${className || ''}`} ref={root} onKeyDown={open ? onKeyDown : undefined}>
      <button
        type='button' ref={trigger} className='turf-trigger'
        aria-haspopup='dialog' aria-expanded={open}
        aria-label={`location: ${sub}`}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span>{sub}</span><span className='turf-caret' aria-hidden='true'>▾</span>
      </button>
      {open && (
        <div role='dialog' aria-label='switch turf' className='turf-popover'>
          <div className='turf-titlebar'>
            <span aria-hidden='true'>cd ~</span>
            <button type='button' onClick={() => close()} aria-label='close'><span aria-hidden='true'>esc ✕</span></button>
          </div>
          <label className='turf-search'>
            <span className='turf-prompt' aria-hidden='true'>&gt;</span>
            <span className='turf-sr'>find a turf</span>
            <input
              ref={input} type='text' value={q} onChange={e => setQ(e.target.value)}
              placeholder='type a turf name' autoComplete='off' autoCapitalize='none' spellCheck={false}
            />
          </label>
          <div className='turf-list' ref={list}>
            {joined.length > 0 && <div className='turf-group' role='presentation'>── your turfs ──</div>}
            <ul className='list-unstyled m-0'>{joined.map(n => row(n, false))}</ul>
            {muted.length > 0 && <div className='turf-group' role='presentation'>── muted ──</div>}
            <ul className='list-unstyled m-0'>{muted.map(n => row(n, true))}</ul>
            {joined.length + muted.length === 0 && <div className='turf-empty' role='status'>cd: no such turf: {q}</div>}
          </div>
          <div className='turf-footer'>
            <button type='button' className='btn btn-link p-0 border-0' style={{ fontFamily: 'inherit', fontSize: 'inherit' }} onClick={() => pick('create')}>create a turf</button>
            <span aria-hidden='true'>↑↓ select · ⏎ open</span>
          </div>
        </div>
      )}
    </div>
  )
}
