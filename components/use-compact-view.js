import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'compactView'
const CLASS_NAME = 'compact-feed'

const read = () => window.document.documentElement.classList.contains(CLASS_NAME)

// Compact feed view preference. The layout itself is pure CSS keyed on the
// compact-feed class on <html> (see styles/stealth-theme.scss), which an
// inline script in pages/_document.js applies before first paint so there is
// no flash of the default layout on reload. This hook only mirrors that state
// for the footer toggle icon, like the dark mode toggle mirrors data-bs-theme.
export default function useCompactView () {
  const [compact, setCompact] = useState(false)

  useEffect(() => {
    // the class is the source of truth; keep it and the icon in lockstep
    const sync = (value) => {
      window.document.documentElement.classList.toggle(CLASS_NAME, value)
      setCompact(value)
    }

    sync(read())

    // storage events fire only in OTHER tabs: apply the incoming preference
    // to this tab's class (its inline script only ran at its own load)
    const onStorage = (e) => { if (e.key === STORAGE_KEY) sync(e.newValue === 'true') }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const toggle = useCallback(() => {
    const next = !read()
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? 'true' : 'false')
    } catch (err) {}
    window.document.documentElement.classList.toggle(CLASS_NAME, next)
    setCompact(next)
  }, [])

  return [compact, toggle]
}
