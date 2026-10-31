import * as cookie from 'cookie'
import { cookieOptions } from '@/lib/auth'

// The feed sort (lit/new/top) the user last picked from the nav tabs. It is a
// plain JS-readable cookie so the lit feed's getServerSideProps can send the
// user straight to their sort before anything renders: brand/logo, turf
// switcher, footer links and fresh visits all land on the bare lit route.
export const FEED_SORT_COOKIE = 'feed_sort'
const FEED_SORT_MAX_AGE = 60 * 60 * 24 * 365

// remembered sort -> path suffix appended to the feed prefix ('' or /~sub);
// lit is the default and is stored as the cookie's absence
export const FEED_SORT_PATHS = {
  new: '/new',
  top: '/top/posts/day'
}

// called from the nav sort tabs' onClick, before the Link navigates, so the
// lit feed's SSR sees the new choice on the same navigation
export function rememberFeedSort (sort) {
  const remembered = FEED_SORT_PATHS[sort]
  document.cookie = cookie.serialize(FEED_SORT_COOKIE, remembered ? sort : '',
    cookieOptions({ httpOnly: false, maxAge: remembered ? FEED_SORT_MAX_AGE : 0 }))
}

// redirect destination for a request to the bare lit feed, or null to render it
export function feedSortRedirect ({ req, sub }) {
  const suffix = FEED_SORT_PATHS[req.cookies?.[FEED_SORT_COOKIE]]
  if (!suffix) return null
  // custom domains hide the ~sub prefix (proxy.js rewrites /new -> /~sub/new)
  const prefix = sub && !req.headers['x-stacker-news-domain'] ? `/~${sub}` : ''
  return prefix + suffix
}
