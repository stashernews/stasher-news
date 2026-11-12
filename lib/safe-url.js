const isProd = process.env.NODE_ENV === 'production'

// True iff the current request was served over HTTPS. In prod this is always
// true (the ALB terminates TLS). In dev it depends on whether the request
// came in via a TLS-terminating proxy (https) or directly to localhost:3000
// (http) — used to gate the Secure cookie attribute so localhost dev still
// works while the custom-domain HTTPS path exercises the full secure-cookie
// codepath.
//
// Accepts either an edge NextRequest, a Node IncomingMessage, or undefined.
// When called in the browser with no req, derives from window.location.
export function isSecureRequest (req) {
  if (isProd) return true
  if (!req) {
    if (typeof window !== 'undefined') return window.location.protocol === 'https:'
    return false
  }
  // X-Forwarded-Proto wins: it's the authoritative client protocol when a
  // TLS-terminating proxy (Caddy/external LB in dev, ALB in prod) is in
  // front. On edge NextRequest, req.nextUrl.protocol reflects the inbound hop
  // to the app (plain http behind Caddy), so we must consult the header first.
  const headers = req.headers
  const xfp = typeof headers?.get === 'function' ? headers.get('x-forwarded-proto') : headers?.['x-forwarded-proto']
  if (xfp) return xfp === 'https'
  // No proxy in front: fall back to the actual inbound protocol (edge only;
  // bare Node IncomingMessage has no equivalent and stays false).
  if (req.nextUrl?.protocol) return req.nextUrl.protocol === 'https:'
  return false
}

// True iff url is an absolute plain-http URL whose host is exactly the
// configured onion mirror address (ONION_HOST, no scheme — the same value the
// onion overlay and the Caddy Onion-Location gate use). The comparison is
// host-exact (a port-suffixed lookalike does not match), the configured value
// must itself be a v3 onion address (an operator typo like a clearnet host
// fails closed instead of allowlisting that host), and the trust root is
// deployment config, never user input.
const V3_ONION_ADDRESS = /^[a-z2-7]{56}\.onion$/

export function isOnionOriginUrl (url, onionHost) {
  if (typeof onionHost !== 'string') return false
  const configured = onionHost.trim().toLowerCase()
  if (!V3_ONION_ADDRESS.test(configured)) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' && parsed.host.toLowerCase() === configured
  } catch {
    return false
  }
}

// Login flows must stay on the mirror the visitor came in on: next-auth
// resolves callbackUrls against NEXTAUTH_URL (the canonical origin), which
// would bounce a mirror login to clearnet, where the host-scoped session
// cookie it just issued does not apply. When browsing on the mirror, hand
// next-auth an absolute mirror-origin callback instead. Already-absolute
// URLs pass through unchanged (idempotent; the server-side allowlist still
// judges them). Pass an explicit `loc` in tests; defaults to window.location
// and degrades to a no-op during SSR.
export function mirrorAuthCallbackUrl (path, loc = typeof window !== 'undefined' ? window.location : null) {
  if (!loc || !/\.onion$/i.test(loc.hostname)) return path
  if (typeof path === 'string' && /^https?:\/\//i.test(path)) return path
  return loc.origin + (typeof path === 'string' && path.startsWith('/') ? path : '/')
}

export function isSafeRedirectPath (uri) {
  if (typeof uri !== 'string' || uri.length === 0) return false
  if (uri[0] !== '/') return false
  if (uri[1] === '/' || uri[1] === '\\') return false
  try {
    // arbitrarily resolve against the main domain. if the origin changes, it's unsafe
    const base = process.env.NEXT_PUBLIC_URL
    return new URL(uri, base).origin === base
  } catch {
    return false
  }
}

export function parseSafeHost (host) {
  if (typeof host !== 'string') return null

  const raw = host.trim()
  if (!raw || raw !== host) return null
  if (/[/?#\\@]/.test(raw)) return null

  try {
    const url = new URL(`http://${raw}`)
    // e.g. https://active-domain.com:443@evil.com is rejected
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    if (!url.hostname) return null

    return {
      hostname: url.hostname.toLowerCase(),
      port: url.port || null
    }
  } catch {
    return null
  }
}

export function formatHost ({ hostname, port }) {
  return port ? `${hostname}:${port}` : hostname
}

export function safeRedirectPath (uri, allowedHost) {
  if (!uri) return '/'
  if (isSafeRedirectPath(uri)) return uri

  const parsedAllowedHost = parseSafeHost(allowedHost)
  if (!parsedAllowedHost) return '/'

  try {
    const parsedUri = new URL(uri)
    const parsedUriHost = parseSafeHost(parsedUri.host)
    // Absolute URLs are accepted only when they target the same canonical host.
    // We return only the path so callers redirect on their own current origin.
    if (parsedUriHost && formatHost(parsedUriHost) === formatHost(parsedAllowedHost)) {
      return (parsedUri.pathname || '/') + parsedUri.search + parsedUri.hash
    }
  } catch {}

  return '/'
}

export function getRequestOrigin (req) {
  const parsed = parseSafeHost(req?.headers?.host)
  if (!parsed) return null

  const protocol = isSecureRequest(req) ? 'https' : 'http'
  return `${protocol}://${formatHost(parsed)}`
}
