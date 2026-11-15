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

// The origin a request actually arrived on, resolved from the headers
// next-auth would consult if it consulted anything (x-forwarded-host/host
// and x-forwarded-proto) — v4 returns NEXTAUTH_URL unconditionally instead,
// pinning every redirect to the clearnet origin even for mirror traffic
// with truthful Host headers. Null when the headers do not form a URL.
function requestOrigin (req) {
  const headers = req?.headers ?? {}
  const host = headers['x-forwarded-host'] ?? headers.host
  if (typeof host !== 'string' || host.length === 0) return null
  const proto = String(headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim() || 'http'
  try {
    return new URL(`${proto}://${host}/`).origin
  } catch {
    return null
  }
}

// Intercept a Next API response so next-auth's redirects stay on the onion
// mirror. next-auth builds every auth redirect from NEXTAUTH_URL — the
// post-send verify-request hop, the CSRF and error bounces, the post-login
// callback — so on mirror traffic each one is clearnet-shaped and silently
// pulls the visitor out of the circuit mid-flow (an email login submitted on
// the mirror landed on clearnet /email, where the origin-scoped
// sessionStorage leaves the magic-code form permanently disabled, and a code
// entered there minted a clearnet session the mirror never saw). Every
// redirect leaves the handler through exactly two doors — the Location
// header or the JSON {url} body — so that is where the canonical origin is
// swapped for the mirror origin the request arrived on. Only the canonical
// origin is ever rewritten, and only for requests that verifiably arrived on
// the configured mirror (ONION_HOST is deployment config; the check is
// host-exact and plain-http, so it fails closed); anything else passes
// through untouched, and the response is returned as-is when interception does
// not apply.
export function mirrorAuthRedirectRes (req, res) {
  const mirrorOrigin = requestOrigin(req)
  if (!mirrorOrigin || !isOnionOriginUrl(`${mirrorOrigin}/`, process.env.ONION_HOST)) return res

  let canonicalOrigin
  try {
    canonicalOrigin = new URL(process.env.NEXTAUTH_URL).origin
  } catch {
    return res
  }

  const rewrite = (url) => {
    if (typeof url !== 'string') return url
    try {
      const parsed = new URL(url)
      if (parsed.origin !== canonicalOrigin) return url
      return mirrorOrigin + parsed.pathname + parsed.search + parsed.hash
    } catch {
      return url
    }
  }

  // Next.js helpers close over this exact response: status(302) returns it.
  // Intercept in place so chained writes cannot escape through the original.
  const setHeader = res.setHeader.bind(res)
  const json = res.json.bind(res)
  res.setHeader = (name, value) =>
    setHeader(name, String(name).toLowerCase() === 'location' ? rewrite(value) : value)
  res.json = (body) => json(body?.url ? { ...body, url: rewrite(body.url) } : body)
  return res
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
