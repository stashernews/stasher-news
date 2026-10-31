import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'compactView'

// feed view -> class on <html>. 'list' (listing) is the default and carries
// no class; 'log' is the original compact view and keeps its storage value
// ('true') and class so existing preferences carry over; 'panel' is the
// boxed-card grid.
export const FEED_VIEWS = ['list', 'log', 'panel']
const VIEW_CLASS = { log: 'compact-feed', panel: 'panel-feed' }
const STORED = { list: 'false', log: 'true', panel: 'panel' }

const read = () => {
  const cl = window.document.documentElement.classList
  if (cl.contains(VIEW_CLASS.log)) return 'log'
  if (cl.contains(VIEW_CLASS.panel)) return 'panel'
  return 'list'
}

const apply = (view) => {
  const cl = window.document.documentElement.classList
  Object.entries(VIEW_CLASS).forEach(([v, c]) => cl.toggle(c, v === view))
}

const fromStored = (value) => value === 'true' ? 'log' : value === 'panel' ? 'panel' : 'list'

// Feed view preference. The layout itself is pure CSS keyed on the
// compact-feed / panel-feed class on <html> (see styles/stealth-theme.scss and
// styles/retro-theme.scss), which an inline script in pages/_document.js applies
// before first paint so there is no flash of the default layout on reload.
// This hook only mirrors that state for the footer control, like the dark mode
// toggle mirrors data-bs-theme.
export default function useFeedView () {
  const [view, setView] = useState('list')

  useEffect(() => {
    // the class is the source of truth; keep it and the control in lockstep
    const sync = (value) => {
      apply(value)
      setView(value)
    }

    sync(read())

    // storage events fire only in OTHER tabs: apply the incoming preference
    // to this tab's class (its inline script only ran at its own load)
    const onStorage = (e) => { if (e.key === STORAGE_KEY) sync(fromStored(e.newValue)) }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const choose = useCallback((next) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, STORED[next])
    } catch (err) {}
    apply(next)
    setView(next)
  }, [])

  return [view, choose]
}
