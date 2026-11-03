import Alert from 'react-bootstrap/Alert'
import { useEffect, useState } from 'react'
import { gql } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import { announcementParts } from '@/lib/announcement'
import { isExternal } from '@/lib/url'
import styles from './announcement-banner.module.css'

const ANNOUNCEMENT = gql`{ announcement }`
const DISMISSED_KEY = 'announcement-dismissed'

// The operator's site-wide announcement (admin panel → Site switches →
// Announcement). Plain text; http(s) URLs become links. Dismissing hides that exact message; a new
// announcement shows again.
export default function AnnouncementBanner () {
  const { data } = useQuery(ANNOUNCEMENT, { fetchPolicy: 'cache-and-network' })
  const message = data?.announcement
  const [dismissed, setDismissed] = useState(null)

  useEffect(() => {
    try { setDismissed(window.localStorage.getItem(DISMISSED_KEY)) } catch {}
  }, [])

  if (!message || dismissed === message) return null

  return (
    <Alert
      className={`fw-bold mt-3 mb-0 text-break ${styles.banner}`} role='status'
      onClose={() => {
        setDismissed(message)
        try { window.localStorage.setItem(DISMISSED_KEY, message) } catch {}
      }}
      dismissible
    >
      {announcementParts(message).map((part, i) => part.href
        ? <a key={i} href={part.href} {...(isExternal(part.href) ? { target: '_blank', rel: 'noopener noreferrer nofollow' } : {})}>{part.text}</a>
        : <span key={i}>{part.text}</span>)}
    </Alert>
  )
}
