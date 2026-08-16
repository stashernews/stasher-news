import { snFetch } from '@/lib/fetch'
import { URL } from 'node:url'

// Domain list mirrors url-unshort's purpose but expansion happens through
// snFetch so every hop is SSRF-validated (private-IP/refused, https-only
// downgrade rules) exactly like every other outbound fetch.
const SHORTENER_HOSTS = new Set([
  't.co', 'bit.ly', 'goo.gl', 'tinyurl.com', 'is.gd', 'buff.ly', 'rebrand.ly',
  'cutt.ly', 'shorturl.at', 'ow.ly', 'bit.do', 'rb.gy', 'soo.gd', 's2r.co',
  'tiny.cc', 'vg.gg'
])

export function isProbablyShortened (url) {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && SHORTENER_HOSTS.has(u.hostname.toLowerCase())
  } catch {
    return false
  }
}

export async function unshorten (url, { maxHops = 5 } = {}) {
  if (typeof url !== 'string' || !isProbablyShortened(url)) {
    try { return typeof url === 'string' ? new URL(url).toString() : null } catch { return null }
  }
  let current = url
  for (let hop = 0; hop < maxHops; hop++) {
    let res
    try {
      // HEAD first; some shorteners lack HEAD support -> fall back to GET
      // with snFetch's small body cap. Redirects are followed by snFetch's
      // hop-validating agent; res.url is the final hop.
      res = await snFetch(current, { method: 'HEAD', timeout: 5000, redirect: 'follow' })
    } catch {
      try {
        res = await snFetch(current, { method: 'GET', timeout: 5000, redirect: 'follow' })
      } catch {
        return current
      }
    }
    const finalUrl = res.url || current
    if (finalUrl === current || !isProbablyShortened(finalUrl)) return finalUrl
    current = finalUrl
  }
  return current
}
